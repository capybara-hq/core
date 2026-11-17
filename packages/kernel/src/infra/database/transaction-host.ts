// Ported from octok-platform libs/common/src/typeorm/transaction-context.ts (owner-approved, 2026-10-28).
// Adapted to Kysely: the context holds a Kysely `Transaction` instead of a TypeORM QueryRunner.
import { AsyncLocalStorage } from "node:async_hooks";
import { Inject, Injectable } from "@nestjs/common";
import type { AccessMode, IsolationLevel, Kysely, Transaction } from "kysely";
import type { KernelLogger } from "../../log.js";
import { KERNEL_LOGGER, KERNEL_POOL } from "../tokens.js";

import {
  runOwnedStartupActivation,
  type StartupActivationOptions,
  startupActivationGuard,
} from "./startup-activation-transaction.js";

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
  /** Transaction-local advisory lock claims; never authority cached across requests. */
  permissionLocks?: Map<string, "shared" | "exclusive">;
  /**
   * How a fence admitted it (`withTransactionFence`), once the fence ran; undefined when no fence
   * admitted it (no fence in context, or read only).
   */
  admission?: AdmissionMode;
}

/** One store for the process: `afterCommit` (a free function) reads it without a host instance. */
const storage = new AsyncLocalStorage<TransactionStore>();

/** How a fence admits the transaction it runs in ({@link TransactionOptions.admission}). */
export interface FenceAdmission {
  /** The transaction asked for shared admission (`admission: "shared"`). */
  shared: boolean;
  /**
   * The ordered authority prelude ({@link withTransactionFencePrelude}; never with `shared`): the
   * fence runs it exactly once, after its org-level admission (the org row) and before any
   * conversation row, the place of the permission authority locks in the global lock order.
   */
  prelude?: () => Promise<void>;
}

/** The mode a fence admitted a transaction in (a fence returning nothing admits exclusively). */
export type AdmissionMode = "shared" | "exclusive";

/** A fence: checks the caller's authority, takes its admission locks and says in which mode. */
export type TransactionFence = (
  admission: FenceAdmission,
) => Promise<AdmissionMode | undefined | void>;

/** A caller's execution authority, checked inside every new transaction before domain writes. */
const fences = new AsyncLocalStorage<TransactionFence>();

export function withTransactionFence<T>(fence: TransactionFence, fn: () => Promise<T>): Promise<T> {
  return fences.run(fence, fn);
}

/**
 * Whether a fence is installed in this context (a claimed run's `RunExecution.withClaim`). A writer
 * whose transaction must hold the org row before its permission authority locks requires it: only
 * an inherited fence runs the ordered prelude after the org row.
 */
export function hasTransactionFence(): boolean {
  return fences.getStore() !== undefined;
}

/**
 * Install once before opening a transaction: the ordered authority (the permission authority
 * locks) runs inside the inherited run fence, after its org row and before its conversation rows.
 * The global lock order (`OrgLock`): org admission -> org row -> permission authority locks
 * (platform, org, device, root) -> root conversation -> conversation. Offboarding and the org
 * writers hold the org row when they take an org permission lock exclusively, so a prelude that
 * took its shared permission locks before the fence's org row could deadlock with them.
 * Existing transactions are rejected because their row locks cannot be retroactively reordered.
 * The inherited fence remains intact; this does not expose an unfenced callback or dispatch API.
 */
export function withTransactionFencePrelude<T>(
  prelude: () => Promise<void>,
  fn: () => Promise<T>,
): Promise<T> {
  if (liveStore())
    throw new Error("An ordered fence prelude must be installed before opening a transaction");
  const inherited = fences.getStore();
  let entered = false;
  return withTransactionFence(async () => {
    if (entered) throw new Error("An ordered fence prelude permits only one new transaction");
    entered = true;
    if (!inherited) {
      await prelude();
      return "exclusive";
    }
    let ran = false;
    // the inherited fence admits exclusively: the prelude takes org-level locks, which a shared
    // admission (no org row) must never take
    const mode = await inherited({
      shared: false,
      prelude: async () => {
        if (ran) throw new Error("The ordered fence prelude runs once");
        ran = true;
        await prelude();
      },
    });
    if (!ran) throw new Error("The inherited fence did not run the ordered authority prelude");
    return mode || "exclusive";
  }, fn);
}

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
  /**
   * How the caller's fence (`withTransactionFence`) admits a transaction this call opens (ignored
   * when it joins one, or with no fence in context). Default: the fence's exclusive admission.
   * `shared`: the run loop's own hot-path writes (event appends, checkpoints, the suspend), which
   * the run fence admits under a shared lock so the runs of one org write in parallel
   * (`RunExecution`); a fence may still admit it exclusively (inside a tool step).
   */
  admission?: "shared";
}

/** Logger for hook failures outside a transaction; set by `TransactionHost`, console until then. */
let hookLog: Pick<KernelLogger, "error"> = {
  error: (msg, fields) => console.error(`[afterCommit] ${msg}`, fields ?? ""),
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Queues `fn` on the current live root transaction; with none open, runs it at once. */
export function queueAfterCommit(fn: AfterCommitHook): void {
  startupActivationGuard()?.check();
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

/** Whether the live transaction in context was admitted by a fence (a claimed run's write). */
export function inFencedTransaction(): boolean {
  return liveStore()?.admission !== undefined;
}

/**
 * Throws when the live transaction in context was admitted shared by the run fence
 * (`RunExecution`): such a transaction holds conversation rows without the org row, so taking an
 * org-level lock (`what`: the org row, a membership, an advisory lock) would invert the global lock
 * order org admission → org row → conversations. Called by every org-level lock.
 */
export function assertNotSharedAdmission(what: string): void {
  if (liveStore()?.admission === "shared") {
    throw new Error(
      `${what} inside a transaction the run fence admitted shared: hot-path writes take no ` +
        'org-level lock (open it without admission: "shared")',
    );
  }
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
  return fences.exit(() => storage.exit(fn));
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
    const guard = startupActivationGuard();
    guard?.check();
    const store = liveStore();
    if (guard && store?.pool !== this.pool)
      throw new Error("Startup activation cannot fall back to the shared pool");
    return store?.pool === this.pool ? store.trx : undefined;
  }

  /** Startup-only bounded owned session; all ordinary transaction/fence semantics are retained. */
  async runStartupActivation<T>(
    fn: () => Promise<T>,
    options: StartupActivationOptions,
  ): Promise<T> {
    startupActivationGuard()?.check();
    if (liveStore() || startupActivationGuard())
      throw new Error("Startup activation refuses an existing transaction");
    const hooks: AfterCommitHook[] = [];
    let store: TransactionStore | undefined;
    let result: T;
    try {
      result = await runOwnedStartupActivation(async (trx) => {
        const own: TransactionStore = { pool: this.pool, trx, hooks, done: false };
        store = own;
        return storage.run(own, async () => {
          const fence = fences.getStore();
          if (fence) own.admission = (await fence({ shared: false })) || "exclusive";
          return fn();
        });
      }, options);
    } finally {
      if (store) store.done = true;
    }
    for (const hook of hooks) {
      try {
        // This continuation belongs to the original caller, outside the helper's ALS guard.
        // Late transaction descendants retain that guard permanently.
        await runOutsideTransaction(hook);
      } catch (e) {
        this.log.error("afterCommit hook failed", { error: errMsg(e) });
      }
    }
    return result;
  }

  /**
   * Runs `fn` in a transaction: a throw rolls back, a return commits. REQUIRED (default) joins the
   * transaction in context; `requires_new` always opens its own on the pool; `mandatory` joins the
   * one in context and throws when there is none. Hooks queued by `afterCommit` run after the
   * root's COMMIT, outside any transaction, and are dropped on rollback.
   */
  async run<T>(fn: () => Promise<T>, opts: TransactionOptions = {}): Promise<T> {
    const guard = startupActivationGuard();
    guard?.check();
    const propagation = opts.propagation ?? "required";
    if (guard && propagation === "requires_new")
      throw new Error("Nested requires_new is refused during startup activation");
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
    if (
      opts.admission === "shared" &&
      opts.isolationLevel !== undefined &&
      opts.isolationLevel !== "read committed"
    ) {
      // shared admission reads the org row unlocked after the advisory lock: only a fresh
      // statement snapshot (READ COMMITTED) sees a deletion that committed while it waited
      throw new Error('admission: "shared" needs READ COMMITTED isolation');
    }
    const hooks: AfterCommitHook[] = [];
    let store: TransactionStore | undefined;
    let result: T;
    try {
      let builder = this.pool.transaction();
      if (opts.isolationLevel !== undefined)
        builder = builder.setIsolationLevel(opts.isolationLevel);
      if (opts.accessMode !== undefined) builder = builder.setAccessMode(opts.accessMode);
      result = await builder.execute((trx) => {
        const fence = opts.accessMode === "read only" ? undefined : fences.getStore();
        const own: TransactionStore = { pool: this.pool, trx, hooks, done: false };
        store = own;
        return storage.run(own, async () => {
          // PostgreSQL forbids row locks in a read-only snapshot and enforces that it cannot
          // mutate. Every later mutation or external dispatch still enters a writable fence.
          if (fence) {
            own.admission = (await fence({ shared: opts.admission === "shared" })) || "exclusive";
          }
          return fn();
        });
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
