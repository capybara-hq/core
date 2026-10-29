import {
  type DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type Type,
} from "@nestjs/common";
import { Redis } from "ioredis";
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
 * kernel bus over it (`capybara
 * extensions *` publish `kernel.plugins.changed`; the bootstrap step takes `lock:bootstrap`).
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
}

/**
 * The application context of a CLI command (ruling R13): the config loaded once (no watch), the
 * logger, the database, the CLI's Redis, locks and in-process events, plus only the domain modules
 * the command needs. Run with `NestFactory.createApplicationContext(…, { abortOnError: false })`
 * and closed at the end of the command.
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
        DatabaseModule,
        CliRedisModule,
        LockModule,
        KernelEventsModule,
        ...opts.modules,
      ],
      providers: [{ provide: KERNEL_APP_OPTIONS, useValue: appOptions }],
      exports: [KERNEL_APP_OPTIONS],
    };
  }
}
