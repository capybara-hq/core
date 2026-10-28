// biome-ignore-all lint/suspicious/noExplicitAny: the pool carries no schema types
import type { Kysely } from "kysely";
import type { KernelSchemaDb } from "../../db/kernel-schema.js";
import type { KernelLogger } from "../../log.js";
import { KernelDb } from "./kernel-db.js";
import { legacyKernelView } from "./legacy-view.js";
import { TransactionHost } from "./transaction-host.js";
import { XactLock } from "./xact-lock.js";

/** The database handles of {@link standaloneDatabase}. */
export interface StandaloneDatabase {
  db: KernelDb;
  txHost: TransactionHost;
  xactLock: XactLock;
  /**
   * The `capybara` view for classes not converted yet (R8): its `transaction()` runs through
   * `txHost`, so the converted providers they call (the locks) join it.
   */
  schemaDb: KernelSchemaDb;
}

/**
 * Temporary (ruling R10; Task 5.2 moves the CLI to a Nest application context): the database
 * handles `DatabaseModule` provides, over a pool the caller owns, for code that runs without the
 * kernel application (the CLI's `admin create` / `admin grant`, `@capybara-hq/testing`'s
 * `createLocalAccount`, kernel tests without a kernel).
 */
export function standaloneDatabase(pool: Kysely<any>, log: KernelLogger): StandaloneDatabase {
  const txHost = new TransactionHost(pool, log);
  const db = new KernelDb(pool, txHost);
  return {
    db,
    txHost,
    xactLock: new XactLock(db, txHost),
    schemaDb: legacyKernelView(db, txHost),
  };
}
