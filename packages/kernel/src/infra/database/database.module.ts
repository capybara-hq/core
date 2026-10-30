import {
  type DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
  type Provider,
} from "@nestjs/common";
import type { Kysely } from "kysely";
import { createDb } from "../../db/pool.js";
import type { KernelLogger } from "../../log.js";
import { closeWithin } from "../close-within.js";
import { KernelConfigService } from "../config/kernel-config.service.js";
import { GracefulShutdownModule } from "../lifecycle/graceful-shutdown.module.js";
import { GracefulShutdown } from "../lifecycle/graceful-shutdown.service.js";
import { KERNEL_LOGGER, KERNEL_POOL } from "../tokens.js";
import { KernelDb } from "./kernel-db.js";
import { TransactionHost } from "./transaction-host.js";
import { XactLock } from "./xact-lock.js";

/**
 * Closes the pool at the end of the shutdown (`GracefulShutdown.closeLast`: after everything that
 * uses it has stopped, together with Redis), within what is left of the total stop budget.
 */
@Injectable()
export class PoolLifecycle {
  constructor(
    // biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
    @Inject(KERNEL_POOL) private readonly pool: Kysely<any>,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(GracefulShutdown) private readonly shutdown: GracefulShutdown,
  ) {
    shutdown.closeLast(() => this.close());
  }

  async close(): Promise<void> {
    await closeWithin("pg", this.pool.destroy(), this.shutdown.remainingMs(), this.log);
  }
}

/** The handles over the pool, the same for both pool sources. */
function databaseModule(
  pool: Provider[],
  imports: NonNullable<DynamicModule["imports"]>,
): DynamicModule {
  return {
    module: DatabaseModule,
    global: true,
    imports,
    providers: [...pool, TransactionHost, KernelDb, XactLock],
    exports: [KERNEL_POOL, TransactionHost, KernelDb, XactLock],
  };
}

/** Global: the Kysely pool, `TransactionHost`, the context-aware `KernelDb` and `XactLock`. */
@Global()
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest dynamic module
export class DatabaseModule {
  /** The pool `db.*` of the config describes, closed at shutdown ({@link PoolLifecycle}). */
  static forRoot(): DynamicModule {
    return databaseModule(
      [
        {
          provide: KERNEL_POOL,
          inject: [KernelConfigService, KERNEL_LOGGER],
          useFactory: (config: KernelConfigService, log: KernelLogger) => {
            const { db } = config.get();
            return createDb(
              db.url,
              db.poolMax,
              (err) => log.error("pg idle client error", { err }),
              {
                connectTimeoutMs: db.connectTimeoutMs,
                onClientError: (err) => log.warn("pg client error", { err }),
              },
            );
          },
        },
        PoolLifecycle,
      ],
      [GracefulShutdownModule],
    );
  }

  /**
   * The handles over a pool the caller owns and closes (`@capybara-hq/testing`'s
   * `createLocalAccount`, which has a pool and no config): the context never closes it.
   */
  // biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
  static borrowing(pool: Kysely<any>): DynamicModule {
    return databaseModule([{ provide: KERNEL_POOL, useValue: pool }], []);
  }
}
