import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import type { Kysely } from "kysely";
import { createDb } from "../../db/pool.js";
import type { KernelLogger } from "../../log.js";
import { KernelConfigService } from "../config/kernel-config.service.js";
import { KERNEL_LOGGER, KERNEL_POOL } from "../tokens.js";
import { KernelDb } from "./kernel-db.js";
import { TransactionHost } from "./transaction-host.js";

/** Closes the pool at shutdown (the last step, after everything that uses it has stopped). */
@Injectable()
class PoolLifecycle implements OnApplicationShutdown {
  constructor(
    // biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
    @Inject(KERNEL_POOL) private readonly pool: Kysely<any>,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.destroy().catch(() => {});
  }
}

/** Global: the Kysely pool, `TransactionHost` and the context-aware `KernelDb`. */
@Global()
@Module({
  providers: [
    {
      provide: KERNEL_POOL,
      inject: [KernelConfigService, KERNEL_LOGGER],
      useFactory: (config: KernelConfigService, log: KernelLogger) => {
        const { db } = config.get();
        return createDb(db.url, db.poolMax, (err) => log.error("pg idle client error", { err }), {
          connectTimeoutMs: db.connectTimeoutMs,
        });
      },
    },
    TransactionHost,
    KernelDb,
    PoolLifecycle,
  ],
  exports: [KERNEL_POOL, TransactionHost, KernelDb],
})
export class DatabaseModule {}
