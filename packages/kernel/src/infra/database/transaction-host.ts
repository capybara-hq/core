// Ported from octok-platform libs/common/src/typeorm/transaction-context.ts (owner-approved, 2026-10-28).
// Adapted to Kysely: the context holds a Kysely `Transaction` instead of a TypeORM QueryRunner.
import { AsyncLocalStorage } from "node:async_hooks";
import { Inject, Injectable } from "@nestjs/common";
import type { AccessMode, IsolationLevel, Kysely, Transaction } from "kysely";
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
  /** Set once the transaction settled: continuations that outlive it must not use it. */
  done: boolean;
}

/** One store for the process: `afterCommit` (a free function) reads it without a host instance. */
const storage = new AsyncLocalStorage<TransactionStore>();

export type Propagation = "required" | "requires_new" | "mandatory";

export interface TransactionOptions {
  /**
   * `required` (default): join the transaction in context, else open one. `requires_new`: a
   * separate transaction on the pool, whatever the context. `mandatory`: join the transaction in
   * context, and throw outside one (for methods whose correctness depends on a lock the caller
   * took in its transaction).
   */
  propagation?: Propagation;
  /** Isolation level of a transaction this call opens (ignored when it joins one). */
  isolationLevel?: IsolationLevel;
  /** Access mode of a transaction this call opens (ignored when it joins one). */
  accessMode?: AccessMode;
}

/** Logger for hook failures outside a transaction; set by `TransactionHost`, console until then. */
let hookLog: Pick<KernelLogger, "error"> = {
  error: (msg, fields) => console.error(`[afterCommit] ${msg}`, fields ?? ""),
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Queues `fn` on the current live root transaction; with none open, runs it at once. */
export function queueAfterCommit(fn: AfterCommitHook): void {
  const store = liveStore();
  if (store) {
    store.hooks.push(fn);
    return;
  }
  try {
    const r = fn();
    if (r instanceof Promise) {
      r.catch((e) => hookLog.error("afterCommit hook failed", { error: errMsg(e) }));
    }
  } catch (e) {
    hookLog.error("afterCommit hook failed", { error: errMsg(e) });
  }
}

/** The store of the current context unless its transaction already finished. */
function liveStore(): TransactionStore | undefined {
  const store = storage.getStore();
  return store && !store.done ? store : undefined;
}

/** The transaction store in the current async context (used by `afterCommit`). */
export function currentStore(): TransactionStore | undefined {
  return liveStore();
}

/**
 * Runs `fn` with no transaction in context, whatever the caller had open. Queue processors and
 * scheduled jobs start from here: a job outlives the transaction that enqueued it and must never
 * join (or write through) a transaction that may already be committed or rolled back.
 */
export function runOutsideTransaction<T>(fn: () => T): T {
  return storage.exit(fn);
}

@Injectable()
export class TransactionHost {
  constructor(
    // biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
    @Inject(KERNEL_POOL) private readonly pool: Kysely<any>,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {
    hookLog = log;
  }

  /** The transaction of the current async context on this pool, if any. */
  // biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
  current(): Transaction<any> | undefined {
    const store = liveStore();
    return store?.pool === this.pool ? store.trx : undefined;
  }

  /**
   * Runs `fn` in a transaction: a throw rolls back, a return commits. REQUIRED (default) joins the
   * transaction in context; `requires_new` always opens its own on the pool; `mandatory` joins the
   * one in context and throws when there is none. Hooks queued by `afterCommit` run after the
   * root's COMMIT, outside any transaction, and are dropped on rollback.
   */
  async run<T>(fn: () => Promise<T>, opts: TransactionOptions = {}): Promise<T> {
    const propagation = opts.propagation ?? "required";
    if (propagation === "mandatory") {
      if (!this.current()) {
        throw new Error(
          'propagation "mandatory": no transaction in context (the caller must open one and ' +
            "hold the locks this method relies on)",
        );
      }
      return fn();
    }
    if (propagation === "required" && this.current()) return fn();
    const hooks: AfterCommitHook[] = [];
    let store: TransactionStore | undefined;
    let result: T;
    try {
      let builder = this.pool.transaction();
      if (opts.isolationLevel !== undefined)
        builder = builder.setIsolationLevel(opts.isolationLevel);
      if (opts.accessMode !== undefined) builder = builder.setAccessMode(opts.accessMode);
      result = await builder.execute((trx) => {
        store = { pool: this.pool, trx, hooks, done: false };
        return storage.run(store, fn);
      });
    } finally {
      if (store) store.done = true;
    }
    for (const hook of hooks) {
      try {
        // outside any transaction: a requires_new nested in an outer one must not have its side
        // effects join (and roll back with) the outer transaction
        await runOutsideTransaction(hook);
      } catch (e) {
        this.log.error("afterCommit hook failed", { error: errMsg(e) });
      }
    }
    return result;
  }
}
