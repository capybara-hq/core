import { type DynamicModule, Global, Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import type { Redis } from "ioredis";
import type { Kysely } from "kysely";
import type { KernelAppOptions } from "./app.js";
import { CatalogModule } from "./catalog/catalog.module.js";
import { ChannelsModule } from "./channels/channels.module.js";
import type { KernelConfig } from "./config/schema.js";
import { TitlesModule } from "./conversations/titles.js";
import { ExtensionsModule } from "./extensions/extensions.module.js";
import { ApiModule } from "./http/api.module.js";
import { ErrorFilterModule } from "./http/error-filter.module.js";
import { IdentityModule } from "./identity/identity.module.js";
import { CacheModule } from "./infra/cache/cache.module.js";
import { ConfigModule } from "./infra/config/config.module.js";
import { DatabaseModule } from "./infra/database/database.module.js";
import { KernelEventsModule } from "./infra/events/kernel-events.js";
import { HealthController } from "./infra/health/health.controller.js";
import { HealthModule } from "./infra/health/health.module.js";
import { databaseCheck, HEALTH_CHECKS, redisCheck } from "./infra/health/health.options.js";
import { GracefulShutdownModule } from "./infra/lifecycle/graceful-shutdown.module.js";
import { LockModule } from "./infra/lock/lock.module.js";
import { LoggingModule } from "./infra/logging/logging.module.js";
import { QueueModule } from "./infra/queue/queue.module.js";
import { RedisModule } from "./infra/redis/redis.module.js";
import { KernelThrottlerModule } from "./infra/throttler/throttler.module.js";
import { KERNEL_POOL, REDIS } from "./infra/tokens.js";
import { ValidationModule } from "./infra/validation/validation.module.js";
import { KernelLifecycle } from "./lifecycle/kernel-lifecycle.js";
import { KERNEL_APP_OPTIONS } from "./lifecycle/tokens.js";
import { createConfiguredLogger } from "./log-config.js";
import { KERNEL_OVERRIDE_TOKENS } from "./overrides.js";
import { GatewayModule } from "./roles/gateway.module.js";
import { WorkerModule } from "./roles/worker.module.js";
import { UsageReportModule } from "./runtime/usage-report.js";

/**
 * Global: the options the application was built with (`KERNEL_APP_OPTIONS`) and its `overrides`,
 * the test seams (`KernelOverride`: values for the named seam tokens the domain modules
 * resolve as optional providers). A token outside {@link KERNEL_OVERRIDE_TOKENS} is refused, so no
 * domain class can be replaced this way.
 */
@Global()
@Module({})
class KernelAppOptionsModule {
  static forRoot(options: KernelAppOptions): DynamicModule {
    const overrides = options.overrides ?? [];
    for (const o of overrides) {
      if (!KERNEL_OVERRIDE_TOKENS.has(o.provide)) {
        const token: unknown = o.provide;
        const name = typeof token === "function" ? token.name : String(token);
        throw new Error(`overrides: ${name} is not a kernel test seam`);
      }
    }
    return {
      module: KernelAppOptionsModule,
      global: true,
      providers: [{ provide: KERNEL_APP_OPTIONS, useValue: options }, ...overrides],
      // an application enhancer (`APP_INTERCEPTOR`) applies globally from any module and is never
      // exported (Nest gives it a unique token)
      exports: [
        KERNEL_APP_OPTIONS,
        ...overrides.map((o) => o.provide).filter((t) => t !== APP_INTERCEPTOR),
      ],
    };
  }
}

/**
 * The kernel application's root module (nest kernel spec §2): the global infra (config, logging,
 * the shutdown state, database, Redis, locks, cache, queues, throttler), the application options,
 * the domain modules `KernelLifecycle` uses, the role modules by `roles` (`ApiModule`: the
 * controllers; `WorkerModule`: every cron and queue consumer; `GatewayModule`: the channel
 * supervisor and the webhook inbound), the health endpoints and the global error filter on every
 * role, and {@link KernelLifecycle}, which owns the start order and the stop phases (it drives the
 * worker and gateway roles' parts, `WorkerRole` / `GatewayRole`). `KernelLifecycle` sits in the
 * root module on purpose: Nest runs shutdown hooks from the root outwards, so its stop phases
 * finish before the global infra closes Redis and the pool.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest dynamic module
export class KernelModule {
  static forRoot(config: KernelConfig, options: KernelAppOptions = {}): DynamicModule {
    const logger = options.logger ?? createConfiguredLogger(config);
    return {
      module: KernelModule,
      imports: [
        LoggingModule.forRoot(config, { logger }),
        ConfigModule.forRoot(config, options.env !== undefined ? { env: options.env } : {}),
        GracefulShutdownModule,
        DatabaseModule.forRoot(),
        RedisModule,
        LockModule,
        CacheModule,
        KernelEventsModule,
        QueueModule.forRoot(),
        KernelThrottlerModule,
        HealthModule,
        ValidationModule,
        ErrorFilterModule,
        KernelAppOptionsModule.forRoot({ ...options, logger }),
        // KernelLifecycle's setup check, the extension host it drives, the catalog it syncs and
        // the producers its stop closes on every role (titles, usage.report, channel deliveries)
        IdentityModule,
        ExtensionsModule,
        CatalogModule,
        TitlesModule,
        UsageReportModule,
        ChannelsModule,
        // the role modules, by `roles` (nest kernel spec §2)
        ...(config.roles.includes("api") ? [ApiModule] : []),
        ...(config.roles.includes("worker") ? [WorkerModule.forRoot(config)] : []),
        ...(config.roles.includes("gateway") ? [GatewayModule] : []),
      ],
      controllers: [HealthController],
      providers: [
        {
          provide: HEALTH_CHECKS,
          inject: [KERNEL_POOL, REDIS],
          // biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
          useFactory: (pool: Kysely<any>, redis: Redis) => ({
            pg: databaseCheck(pool),
            redis: redisCheck(redis),
          }),
        },
        KernelLifecycle,
      ],
    };
  }
}
