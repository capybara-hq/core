import { type DynamicModule, Global, Module } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { Kysely } from "kysely";
import type { KernelAppOptions } from "./app.js";
import { CatalogModule } from "./catalog/catalog.module.js";
import { ChannelRolesModule } from "./channels/channels.module.js";
import type { KernelConfig } from "./config/schema.js";
import { EvalWorkersModule } from "./evals/evals.module.js";
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
import { KernelScheduleModule } from "./infra/schedule/schedule.module.js";
import { KernelThrottlerModule } from "./infra/throttler/throttler.module.js";
import { KERNEL_POOL, REDIS } from "./infra/tokens.js";
import { ValidationModule } from "./infra/validation/validation.module.js";
import { KernelLifecycle } from "./lifecycle/kernel-lifecycle.js";
import { KERNEL_APP_OPTIONS } from "./lifecycle/tokens.js";
import { createConfiguredLogger } from "./log-config.js";
import { MaintenanceModule } from "./runtime/maintenance.js";
import { RuntimeWorkersModule } from "./runtime/run-processors.js";

/**
 * Global: the options the application was built with (`KERNEL_APP_OPTIONS`) and the application's
 * `overrides` (test seams such as `AGENT_LOOP_FACTORY`, `RUN_HOOKS`, `EVAL_REPLAY_HOOKS`, which the
 * domain modules resolve as optional providers; Task 5.3 replaces them with Nest's testing
 * overrides).
 */
@Global()
@Module({})
class KernelAppOptionsModule {
  static forRoot(options: KernelAppOptions): DynamicModule {
    const overridden = (options.overrides ?? []).map((o) => o.provide as symbol);
    return {
      module: KernelAppOptionsModule,
      global: true,
      providers: [
        { provide: KERNEL_APP_OPTIONS, useValue: options },
        ...(options.overrides ?? []).map((o) => ({
          provide: o.provide as symbol,
          useValue: o.useValue,
        })),
      ],
      exports: [KERNEL_APP_OPTIONS, ...overridden],
    };
  }
}

/**
 * The kernel application's root module (nest kernel spec §2): the global infra (config, logging,
 * the shutdown state, database, Redis), the application options, the domains' role modules, the API when the roles include `api`, the health
 * endpoints and the global error filter on every role, and {@link KernelLifecycle}, which owns the
 * start order and the stop phases. `KernelLifecycle` sits in the root module on purpose: Nest runs
 * shutdown hooks from the root outwards, so its stop phases finish before the global infra closes
 * Redis and the pool.
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
        DatabaseModule,
        RedisModule,
        LockModule,
        CacheModule,
        KernelEventsModule,
        QueueModule.forRoot(),
        KernelScheduleModule,
        KernelThrottlerModule,
        HealthModule,
        ValidationModule,
        ErrorFilterModule,
        KernelAppOptionsModule.forRoot({ ...options, logger }),
        // KernelLifecycle's setup check, the extension host it drives and the catalog it syncs
        IdentityModule,
        ExtensionsModule,
        CatalogModule,
        // the run worker, usage.report and title consumers (started on the worker role)
        RuntimeWorkersModule.forRoot(config),
        // channels; the channel queue's consumer (worker role), the long-connection supervisor and
        // the webhook inbound (gateway role)
        ChannelRolesModule.forRoot(config),
        // the eval worker; the eval queue's consumer (worker role)
        EvalWorkersModule.forRoot(config),
        // the maintenance queue's one consumer (worker role)
        MaintenanceModule.forRoot(config),
        ...(config.roles.includes("api") ? [ApiModule] : []),
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
