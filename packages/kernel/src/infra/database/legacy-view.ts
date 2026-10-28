import type { KernelSchemaDb } from "../../db/kernel-schema.js";
import type { KernelDb } from "./kernel-db.js";

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

/**
 * Temporary (Phase 3 removes it with the legacy graph): what the not yet converted domain classes
 * take, a Kysely `capybara` view, backed by the single `KernelDb`. Query entry points follow the
 * async context, so code that runs inside `@Transactional()` sees its transaction; everything else
 * (`transaction()`, `connection()`, `withSchema()`, `destroy()`, ...) is the pool's, exactly as
 * before, because those classes open their own transactions and need a connection of their own.
 */
export function legacyKernelView(kdb: KernelDb): KernelSchemaDb {
  const pool = kdb.pool.withSchema("capybara");
  return new Proxy(pool, {
    get(target, prop) {
      if (CONTEXT_AWARE.has(prop)) {
        const v = Reflect.get(kdb, prop) as unknown;
        return typeof v === "function" ? v.bind(kdb) : v;
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as unknown as KernelSchemaDb;
}
