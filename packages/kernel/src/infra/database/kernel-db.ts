import { Inject, Injectable } from "@nestjs/common";
import type { Kysely, Transaction } from "kysely";
import { type KernelDatabase, kernelDb } from "../../db/kernel-schema.js";
import { KERNEL_POOL } from "../tokens.js";
import { TransactionHost } from "./transaction-host.js";

type View = Kysely<KernelDatabase>;

/** The Kysely query entry points services use; each resolves to the context transaction or the pool. */
const QUERY_METHODS = [
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
] as const;

type QueryMethod = (typeof QUERY_METHODS)[number];

// Declaration merging types the proxied query methods that are attached to the prototype below.
export interface KernelDb extends Pick<View, QueryMethod | "fn"> {}

/**
 * What services inject instead of a Kysely instance: every call resolves to the transaction of
 * the current async context (opened by `@Transactional()`), else to the pool; the `capybara`
 * schema view applies either way. No `trx` parameters are passed around.
 */
@Injectable()
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: types the prototype-attached query methods
export class KernelDb {
  constructor(
    // biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
    @Inject(KERNEL_POOL) readonly pool: Kysely<any>,
    @Inject(TransactionHost) private readonly txHost: TransactionHost,
  ) {}

  /** The kernel-schema handle of the current context (transaction or pool). */
  get db(): View | Transaction<KernelDatabase> {
    return kernelDb(this.txHost.current() ?? this.pool);
  }
}

for (const name of QUERY_METHODS) {
  Object.defineProperty(KernelDb.prototype, name, {
    value(this: KernelDb, ...args: unknown[]) {
      return (this.db[name] as (...a: unknown[]) => unknown)(...args);
    },
  });
}
Object.defineProperty(KernelDb.prototype, "fn", {
  get(this: KernelDb) {
    return this.db.fn;
  },
});
