import type { AccessMode, IsolationLevel, Transaction } from "kysely";
import { type KernelDatabase, type KernelSchemaDb, kernelDb } from "../../db/kernel-schema.js";
import type { KernelDb } from "./kernel-db.js";
import { currentStore, type TransactionHost } from "./transaction-host.js";

/** The Kysely entry points that resolve through `KernelDb` (the transaction of the context, else the pool). */
const CONTEXT_AWARE = new Set<PropertyKey>([
  "selectFrom",
  "selectNoFrom",
  "insertInto",
  "replaceInto",
  "updateTable",
  "deleteFrom",
  "mergeInto",
  "with",
  "withRecursive",
  "executeQuery",
  "fn",
]);

interface LegacyTransactionOptions {
  isolationLevel?: IsolationLevel;
  accessMode?: AccessMode;
}

/** The `transaction()` builder of the legacy view (the subset the legacy classes use). */
interface LegacyTransactionBuilder {
  setIsolationLevel(level: IsolationLevel): LegacyTransactionBuilder;
  setAccessMode(mode: AccessMode): LegacyTransactionBuilder;
  execute<T>(fn: (trx: Transaction<KernelDatabase>) => Promise<T>): Promise<T>;
}

function legacyTransaction(
  txHost: TransactionHost,
  opts: LegacyTransactionOptions,
): LegacyTransactionBuilder {
  return {
    setIsolationLevel: (isolationLevel) => legacyTransaction(txHost, { ...opts, isolationLevel }),
    setAccessMode: (accessMode) => legacyTransaction(txHost, { ...opts, accessMode }),
    // A new transaction on the pool, as before (requires_new), now visible in the async context:
    // converted code (KernelDb, @Transactional) called from inside joins it (ruling R8).
    execute: (fn) =>
      txHost.run(() => fn(legacyCurrentTrx()), { propagation: "requires_new", ...opts }),
  };
}

/**
 * Temporary (Phase 3 removes it with the legacy graph): what the not yet converted domain classes
 * take, a Kysely `capybara` view, backed by the single `KernelDb`. Query entry points follow the
 * async context, so code that runs inside `@Transactional()` sees its transaction. `transaction()`
 * opens a new transaction on the pool, as before, but through `TransactionHost` (ruling R8): its
 * callback runs with that transaction in the async context, so converted code it calls joins it.
 * Everything else (`connection()`, `withSchema()`, `destroy()`, ...) is the pool's.
 */
export function legacyKernelView(kdb: KernelDb, txHost: TransactionHost): KernelSchemaDb {
  const pool = kdb.pool.withSchema("capybara");
  return new Proxy(pool, {
    get(target, prop) {
      if (prop === "transaction") return () => legacyTransaction(txHost, {});
      if (CONTEXT_AWARE.has(prop)) {
        const v = Reflect.get(kdb, prop) as unknown;
        return typeof v === "function" ? v.bind(kdb) : v;
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as unknown as KernelSchemaDb;
}

/**
 * Temporary (dies with this file, ruling R8): the transaction of the current async context as the
 * `capybara` view, for converted `@Transactional` code that calls a not yet converted API taking a
 * transaction parameter. Throws outside a transaction.
 */
export function legacyCurrentTrx(): Transaction<KernelDatabase> {
  const store = currentStore();
  if (!store) throw new Error("legacyCurrentTrx() called outside a transaction");
  return kernelDb(store.trx) as unknown as Transaction<KernelDatabase>;
}
