import {
  type DynamicModule,
  Global,
  type INestApplicationContext,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type Type,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Redis } from "ioredis";
import type { Kysely } from "kysely";
import type { KernelAppOptions } from "../../app.js";
import type { KernelConfig } from "../../config/schema.js";
import { type BusSubscriber, createBus } from "../../ctx/bus.js";
import { KERNEL_APP_OPTIONS } from "../../lifecycle/tokens.js";
import type { KernelLogger } from "../../log.js";
import { ConfigModule } from "../config/config.module.js";
import { KernelConfigService } from "../config/kernel-config.service.js";
import { DatabaseModule } from "../database/database.module.js";
import { KernelEventsModule } from "../events/kernel-events.js";
import { GracefulShutdownModule } from "../lifecycle/graceful-shutdown.module.js";
import { LockModule } from "../lock/lock.module.js";
import { LoggingModule } from "../logging/logging.module.js";
import { KERNEL_BUS, KERNEL_LOGGER, REDIS, REDIS_SUBSCRIBER } from "../tokens.js";

/** How long the CLI's Redis connection may take before a command fails (a publish only warns). */
const CLI_REDIS_CONNECT_TIMEOUT_MS = 3_000;
/**
 * The cap of the reconnect backoff. The connection keeps reconnecting (a `capybara bootstrap`
 * holding `lock:bootstrap` renews it again once Redis is back), while a command issued on a broken
 * connection still fails after one reconnect attempt (`maxRetriesPerRequest: 1`).
 */
const CLI_REDIS_MAX_BACKOFF_MS = 2_000;

/** The CLI subscribes to nothing: the kernel bus is publish-only there. */
const NO_SUBSCRIBER: BusSubscriber = {
  subscribe: () => Promise.reject(new Error("the CLI does not subscribe")),
};

/** Closes the CLI's Redis connection with the context. */
@Injectable()
export class CliRedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  onApplicationShutdown(): void {
    this.redis.disconnect();
  }
}

/**
 * The CLI's Redis: one lazy connection (a command that never touches Redis never connects), which
 * keeps reconnecting while each command on a broken connection fails fast, and the publish-only
 * kernel bus over it (`capybara extensions *` publish `kernel.plugins.changed`; the bootstrap step
 * takes `lock:bootstrap`).
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [KernelConfigService],
      useFactory: (config: KernelConfigService) => {
        const redis = new Redis(config.get().redis.url, {
          lazyConnect: true,
          connectTimeout: CLI_REDIS_CONNECT_TIMEOUT_MS,
          maxRetriesPerRequest: 1,
          retryStrategy: (times) => Math.min(times * 200, CLI_REDIS_MAX_BACKOFF_MS),
        });
        // a failed publish or lock surfaces where it is used; the CLI's output stays clean
        redis.on("error", () => {});
        return redis;
      },
    },
    { provide: REDIS_SUBSCRIBER, useValue: NO_SUBSCRIBER },
    {
      provide: KERNEL_BUS,
      inject: [REDIS, KERNEL_LOGGER],
      useFactory: (redis: Redis, log: KernelLogger) =>
        createBus(redis, NO_SUBSCRIBER, "kernel", log),
    },
    CliRedisLifecycle,
  ],
  exports: [REDIS, REDIS_SUBSCRIBER, KERNEL_BUS],
})
export class CliRedisModule {}

export interface KernelCliOptions {
  logger: KernelLogger;
  /** Environment overrides (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** The directory bare extension package names are resolved from. */
  resolveFrom?: string;
  /** The domain modules the command needs. */
  modules: (Type | DynamicModule)[];
  /**
   * Whether the context has the CLI's Redis (connection, publish-only bus) and `LockService`
   * (default true). `false` for the commands that only use PostgreSQL (`admin create`,
   * `admin grant`): their context cannot reach Redis at all.
   */
  redis?: boolean;
}

/**
 * The application context of a CLI command (decision R13 of the Nest kernel spec): the config
 * loaded once (no watch), the logger, the database, the CLI's Redis, locks and in-process events,
 * plus only the domain modules the command needs. Open it with {@link openKernelCli} and close it
 * at the end of the command.
 */
@Global()
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest dynamic module
export class KernelCliModule {
  static forRoot(config: KernelConfig, opts: KernelCliOptions): DynamicModule {
    const appOptions: KernelAppOptions = {
      logger: opts.logger,
      ...(opts.env !== undefined && { env: opts.env }),
      ...(opts.resolveFrom !== undefined && { resolveFrom: opts.resolveFrom }),
    };
    return {
      module: KernelCliModule,
      global: true,
      imports: [
        LoggingModule.forRoot(config, { logger: opts.logger }),
        ConfigModule.forRoot(config, opts.env !== undefined ? { env: opts.env } : {}),
        GracefulShutdownModule,
        DatabaseModule.forRoot(),
        ...(opts.redis === false ? [] : [CliRedisModule, LockModule]),
        KernelEventsModule,
        ...opts.modules,
      ],
      providers: [{ provide: KERNEL_APP_OPTIONS, useValue: appOptions }],
      exports: [KERNEL_APP_OPTIONS],
    };
  }

  /**
   * A context over a pool the caller owns, for code that has a pool and no config
   * (`@capybara-hq/testing`'s `createLocalAccount`): the logger, the database handles over `pool`
   * (never closed by the context), in-process events and the given modules. No config, no keyring,
   * no Redis: only modules that need nothing more fit.
   */
  static overPool(
    // biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
    pool: Kysely<any>,
    opts: { logger: KernelLogger; modules: (Type | DynamicModule)[] },
  ): DynamicModule {
    return {
      module: KernelCliModule,
      global: true,
      imports: [
        LoggingModule.forLogger(opts.logger),
        DatabaseModule.borrowing(pool),
        KernelEventsModule,
        ...opts.modules,
      ],
    };
  }
}

/** Creates a Nest application context of `module` the way every CLI context is created. */
function createCliContext(module: DynamicModule): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(module, { logger: false, abortOnError: false });
}

/**
 * Opens a CLI command's application context ({@link KernelCliModule.forRoot}); the caller closes
 * it (`app.close()`: the pool, and the Redis connection when the context has one).
 */
export function openKernelCli(
  config: KernelConfig,
  opts: KernelCliOptions,
): Promise<INestApplicationContext> {
  return createCliContext(KernelCliModule.forRoot(config, opts));
}

/**
 * Opens a context over a pool the caller owns ({@link KernelCliModule.overPool}); closing it
 * leaves the pool open.
 */
export function openKernelCliOverPool(
  // biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
  pool: Kysely<any>,
  opts: { logger: KernelLogger; modules: (Type | DynamicModule)[] },
): Promise<INestApplicationContext> {
  return createCliContext(KernelCliModule.overPool(pool, opts));
}
