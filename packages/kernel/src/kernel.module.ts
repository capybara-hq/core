import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { type DynamicModule, Global, Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { Redis } from "ioredis";
import type { Kysely } from "kysely";
import type { KernelAppOptions } from "./app.js";
import type { KernelConfig } from "./config/schema.js";
import type { BusSubscriber } from "./ctx/bus.js";
import { API_DEPS, ApiModule } from "./http/api.module.js";
import { ErrorFilter } from "./http/error.filter.js";
import { CacheModule } from "./infra/cache/cache.module.js";
import { ConfigModule } from "./infra/config/config.module.js";
import { KernelConfigService } from "./infra/config/kernel-config.service.js";
import { DatabaseModule } from "./infra/database/database.module.js";
import { KernelDb } from "./infra/database/kernel-db.js";
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
import { KERNEL_BUS, KERNEL_LOGGER, KERNEL_POOL, REDIS, REDIS_SUBSCRIBER } from "./infra/tokens.js";
import { ValidationModule } from "./infra/validation/validation.module.js";
import { createLegacyGraph, type KernelTestHooks, type LegacyGraph } from "./kernel.js";
import { KernelLifecycle } from "./lifecycle/kernel-lifecycle.js";
import { KERNEL_APP_OPTIONS, KERNEL_TEST_HOOKS, LEGACY_GRAPH } from "./lifecycle/tokens.js";
import type { KernelLogger } from "./log.js";
import { createConfiguredLogger } from "./log-config.js";

/**
 * Global: the legacy service graph (`LEGACY_GRAPH`, one factory provider over the infra modules)
 * with its inputs. Domains leave it one directory at a time (Phase 3). The application's
 * `overrides` are registered here, after the defaults, so they win.
 */
@Global()
@Module({})
class LegacyGraphModule {
  static forRoot(options: KernelAppOptions): DynamicModule {
    return {
      module: LegacyGraphModule,
      global: true,
      providers: [
        { provide: KERNEL_APP_OPTIONS, useValue: options },
        { provide: KERNEL_TEST_HOOKS, useValue: {} satisfies KernelTestHooks },
        {
          provide: LEGACY_GRAPH,
          inject: [
            KernelConfigService,
            KERNEL_LOGGER,
            KernelDb,
            REDIS,
            REDIS_SUBSCRIBER,
            KERNEL_BUS,
            KERNEL_APP_OPTIONS,
            KERNEL_TEST_HOOKS,
          ],
          useFactory: (
            config: KernelConfigService,
            log: KernelLogger,
            kdb: KernelDb,
            redis: Redis,
            subscriber: BusSubscriber,
            bus: ExtensionContext["bus"],
            opts: KernelAppOptions,
            hooks: KernelTestHooks,
          ): LegacyGraph =>
            createLegacyGraph(config, log, kdb, redis, subscriber, bus, opts, hooks),
        },
        ...(options.overrides ?? []).map((o) => ({
          provide: o.provide as symbol,
          useValue: o.useValue,
        })),
      ],
      exports: [LEGACY_GRAPH, KERNEL_APP_OPTIONS, KERNEL_TEST_HOOKS],
    };
  }
}

/**
 * The kernel application's root module (nest kernel spec §2): the global infra (config, logging,
 * the shutdown state, database, Redis), the legacy service graph, the API when the roles include `api`, the health
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
        QueueModule.forRoot(),
        KernelScheduleModule,
        KernelThrottlerModule,
        HealthModule,
        ValidationModule,
        LegacyGraphModule.forRoot({ ...options, logger }),
        ...(config.roles.includes("api")
          ? [
              ApiModule.registerFrom({
                provide: API_DEPS,
                inject: [LEGACY_GRAPH],
                useFactory: (g: LegacyGraph) => g.apiDeps,
              }),
            ]
          : []),
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
        { provide: APP_FILTER, useClass: ErrorFilter },
        KernelLifecycle,
      ],
    };
  }
}
