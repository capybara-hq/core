// Ported from octok-platform libs/common/src/typeorm/transaction-context.ts (owner-approved, 2026-10-28).
// Adapted to Kysely: the context holds a Kysely `Transaction` instead of a TypeORM QueryRunner.
import { AsyncLocalStorage } from "node:async_hooks";
import { Inject, Injectable } from "@nestjs/common";
import type { Kysely, Transaction } from "kysely";
import type { KernelLogger } from "../../log.js";
import { KERNEL_LOGGER, KERNEL_POOL } from "../tokens.js";

type AfterCommitHook = () => void | Promise<void>;

interface TransactionStore {
  // biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
  pool: Kysely<any>;
  // biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
  trx: Transaction<any>;
  /** Side effects queued by `afterCommit`, run after this root transaction commits. */
  hooks: AfterCommitHook[];
}

/** One store for the process: `afterCommit` (a free function) reads it without a host instance. */
const storage = new AsyncLocalStorage<TransactionStore>();

export type Propagation = "required" | "requires_new";

export interface TransactionOptions {
  /** `required` (default): join the transaction in context, else open one. `requires_new`: a separate transaction on the pool, whatever the context. */
  propagation?: Propagation;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Queues `fn` on the current root transaction; with none open, runs it at once. */
export function queueAfterCommit(fn: AfterCommitHook, log?: Pick<KernelLogger, "error">): void {
  const store = storage.getStore();
  if (store) {
    store.hooks.push(fn);
    return;
  }
  try {
    const r = fn();
    if (r instanceof Promise)
      r.catch((e) => log?.error("afterCommit hook failed", { error: errMsg(e) }));
  } catch (e) {
    log?.error("afterCommit hook failed", { error: errMsg(e) });
  }
}

/** The transaction store in the current async context (used by `afterCommit`). */
export function currentStore(): TransactionStore | undefined {
  return storage.getStore();
}

@Injectable()
export class TransactionHost {
  constructor(
    // biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
    @Inject(KERNEL_POOL) private readonly pool: Kysely<any>,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}

  /** The transaction of the current async context on this pool, if any. */
  // biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
  current(): Transaction<any> | undefined {
    const store = storage.getStore();
    return store?.pool === this.pool ? store.trx : undefined;
  }

  /**
   * Runs `fn` in a transaction: a throw rolls back, a return commits. REQUIRED (default) joins the
   * transaction in context; `requires_new` always opens its own on the pool. Hooks queued by
   * `afterCommit` run after the root's COMMIT and are dropped on rollback.
   */
  async run<T>(fn: () => Promise<T>, opts: TransactionOptions = {}): Promise<T> {
    if ((opts.propagation ?? "required") === "required" && this.current()) return fn();
    const hooks: AfterCommitHook[] = [];
    const result = await this.pool
      .transaction()
      .execute((trx) => storage.run({ pool: this.pool, trx, hooks }, fn));
    for (const hook of hooks) {
      try {
        await hook();
      } catch (e) {
        this.log.error("afterCommit hook failed", { error: errMsg(e) });
      }
    }
    return result;
  }
}
