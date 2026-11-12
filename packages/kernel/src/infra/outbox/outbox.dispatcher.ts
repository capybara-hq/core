import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import type { JobsOptions, Queue } from "bullmq";
import { sql } from "kysely";
import type { KernelLogger } from "../../log.js";
import { KernelDb } from "../database/kernel-db.js";
import { TransactionHost } from "../database/transaction-host.js";
import { Transactional } from "../database/transactional.decorator.js";
import { QUEUE_JOB_DEFAULTS } from "../queue/queue.module.js";
import { KERNEL_QUEUES, type KernelQueueName } from "../queue/queue-names.js";
import { KERNEL_LOGGER } from "../tokens.js";
import { outboxJobOptions } from "./registry.js";

/**
 * Retry schedule of a row whose add failed (spec §3.4): the next attempt waits
 * `min(capMs, baseMs * 2^attempts)`, and the row is dead (kept, never retried) at `maxAttempts`.
 */
export const OUTBOX_BACKOFF = { baseMs: 1000, capMs: 300_000, maxAttempts: 20 } as const;

/**
 * How long the queue adds of one claim pass may take in all: the claim transaction holds its rows'
 * locks and a pool connection for at most about this long.
 */
export const OUTBOX_REDIS_TIMEOUT_MS = 2000;

/**
 * Most fast-path passes running at once in one process; more are skipped and left to the relay,
 * so a slow Redis cannot take the whole pool (a local resource bound, no shared state).
 */
export const OUTBOX_FAST_PATH_CONCURRENCY = 4;

/**
 * Test seam (`KernelOverride`): returns true to make every queue add fail (a Redis outage) without
 * calling Redis. The kernel never provides it; the dispatcher defaults to "never fails".
 */
export const OUTBOX_DISPATCH_FAILS = Symbol("OUTBOX_DISPATCH_FAILS");

/** What one pass did: rows delivered, rows whose add failed, and of those the rows now dead. */
export interface DispatchResult {
  sent: number;
  failed: number;
  dead: number;
}

/** Which rows a pass claims: the fast path's own ids, or the relay's due rows. */
type Claim = { ids: readonly string[] } | { limit: number };

interface FailedGroup {
  ids: string[];
  error: string;
}

/** The queue handle the dispatcher uses: adds, and the connection's state. */
export type OutboxQueue = Pick<Queue, "addBulk" | "getBackend">;

/** Longest `last_error` kept on a row. */
const MAX_ERROR_LENGTH = 2000;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const NOT_READY = Symbol("NOT_READY");

/**
 * Whether the queue's Redis connection is ready now, without waiting: the backend's client
 * promise only settles once connected, so a pending one counts as not ready.
 */
async function connectionReady(queue: OutboxQueue): Promise<boolean> {
  try {
    // an already settled client promise wins the race (its callback is queued first)
    const client = await Promise.race([queue.getBackend().client, Promise.resolve(NOT_READY)]);
    return client !== NOT_READY && client.status === "ready";
  } catch {
    return false;
  }
}

/** Rejects when `p` takes longer than `ms`; a late rejection of `p` is swallowed. */
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  p.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Delivers outbox rows to BullMQ (transactional outbox spec §3.3, §3.4). A pass claims rows
 * `FOR UPDATE SKIP LOCKED` (so concurrent passes never take the same row), adds their jobs per
 * queue with `addBulk` (the queue defaults overlaid by the registry's options of the job name, the
 * row's job id, a future `run_at` as the remaining `delay`), and deletes
 * the delivered rows in the same short transaction. A crash after the add and before the commit
 * leaves the rows; the next pass adds again and BullMQ ignores the existing job id. A queue whose
 * add fails keeps its rows, and a second short update records the attempt with exponential
 * backoff, setting `dead_at` at the last one.
 *
 * The fast path never queues behind an outage: it skips the pass (the relay delivers the rows) when
 * a queue's Redis connection is not ready or {@link OUTBOX_FAST_PATH_CONCURRENCY} passes already
 * run. Within a pass, the first failed queue fails the queues after it without trying them.
 *
 * The queue handles are the instances the queues' owner modules registered (one per queue, no
 * connection of the outbox's own), resolved by token at use time. A queue whose owner this
 * process's roles do not load is not reachable here: no pass claims its rows, which stay for a
 * process that has it.
 */
@Injectable()
export class OutboxDispatcher {
  /** The owners' queue instances resolved so far (a per-process handle cache). */
  private readonly queues = new Map<KernelQueueName, OutboxQueue>();
  /** Fast-path passes running in this process (bounded by OUTBOX_FAST_PATH_CONCURRENCY). */
  private fastPaths = 0;

  constructor(
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(ModuleRef) private readonly moduleRef: Pick<ModuleRef, "get">,
    @Optional()
    @Inject(OUTBOX_DISPATCH_FAILS)
    private readonly dispatchFails: () => boolean = () => false,
  ) {}

  /** The queue instance its owner module registered, or undefined when no loaded module has it. */
  private queue(name: KernelQueueName): OutboxQueue | undefined {
    const known = this.queues.get(name);
    if (known) return known;
    let queue: OutboxQueue | undefined;
    try {
      queue = this.moduleRef.get<OutboxQueue>(getQueueToken(name), { strict: false });
    } catch {
      return undefined;
    }
    if (queue) this.queues.set(name, queue);
    return queue;
  }

  /** The kernel queues this process can add to, with their handles. */
  private reachable(): [KernelQueueName, OutboxQueue][] {
    const found: [KernelQueueName, OutboxQueue][] = [];
    for (const name of KERNEL_QUEUES) {
      const queue = this.queue(name);
      if (queue) found.push([name, queue]);
    }
    return found;
  }

  /**
   * The fast path: delivers the given rows (a committed transaction's own) right away. Never
   * throws: whatever it does not deliver stays for the relay, and a failure is logged.
   */
  async dispatchOwn(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    if (this.fastPaths >= OUTBOX_FAST_PATH_CONCURRENCY) {
      this.log.debug("outbox fast path busy; the relay delivers the rows", { rows: ids.length });
      return;
    }
    this.fastPaths++;
    try {
      if (!(await this.redisReady())) {
        this.log.debug("outbox fast path: Redis not ready; the relay delivers the rows", {
          rows: ids.length,
        });
        return;
      }
      await this.dispatch({ ids });
    } catch (e) {
      this.log.error("outbox fast path failed; the relay delivers the rows", {
        rows: ids.length,
        error: errMsg(e),
      });
    } finally {
      this.fastPaths--;
    }
  }

  /**
   * Every reachable queue's connection is ready (they reach the same Redis; the fast path does not
   * read its rows' queues before claiming them).
   */
  private async redisReady(): Promise<boolean> {
    const ready = await Promise.all(this.reachable().map(([, q]) => connectionReady(q)));
    return ready.every(Boolean);
  }

  /**
   * The relay: delivers up to `limit` due rows (not dead, `next_attempt_at` reached), oldest
   * first.
   */
  dispatchDue(limit: number): Promise<DispatchResult> {
    return this.dispatch({ limit });
  }

  private async dispatch(claim: Claim): Promise<DispatchResult> {
    const { sent, failed } = await this.claimAndSend(claim);
    let dead = 0;
    for (const group of failed) dead += await this.recordFailure(group);
    return { sent, failed: failed.reduce((n, g) => n + g.ids.length, 0), dead };
  }

  /**
   * One claim transaction: locks the rows (skipping rows another pass holds), adds their jobs and
   * deletes the delivered rows. The only Redis calls made while a PG transaction is open in the
   * kernel (spec §3.3): the locks held are outbox rows only, and the pass's adds together are
   * bounded by {@link OUTBOX_REDIS_TIMEOUT_MS}.
   */
  @Transactional({ propagation: "requires_new" })
  private async claimAndSend(claim: Claim): Promise<{ sent: number; failed: FailedGroup[] }> {
    const queues = new Map(this.reachable());
    if (queues.size === 0) return { sent: 0, failed: [] };
    // rows of a queue this process cannot reach are left for a process that can
    let query = this.db
      .selectFrom("outbox")
      .select(["id", "queue", "job_name", "job_id", "data", "run_at"])
      .where("dead_at", "is", null)
      .where("queue", "in", [...queues.keys()]);
    query =
      "ids" in claim
        ? query.where("id", "in", [...claim.ids])
        : query.where("next_attempt_at", "<=", sql<Date>`now()`).limit(claim.limit);
    const rows = await query.orderBy("id").forUpdate().skipLocked().execute();
    if (rows.length === 0) return { sent: 0, failed: [] };

    const byQueue = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = byQueue.get(row.queue);
      if (group) group.push(row);
      else byQueue.set(row.queue, [row]);
    }

    const now = Date.now();
    const deadline = now + OUTBOX_REDIS_TIMEOUT_MS;
    const delivered: string[] = [];
    const failed: FailedGroup[] = [];
    // after the first failure the queues left are failed without a try: Redis is likely down
    let firstError: string | undefined;
    for (const [name, group] of byQueue) {
      const ids = group.map((r) => r.id);
      if (firstError !== undefined) {
        failed.push({
          ids,
          error: `not tried after an earlier queue failed: ${firstError}`.slice(
            0,
            MAX_ERROR_LENGTH,
          ),
        });
        continue;
      }
      try {
        if (this.dispatchFails()) throw new Error("outbox dispatch failure (test seam)");
        const queue = queues.get(name as KernelQueueName);
        if (!queue) throw new Error(`"${name}" is not a kernel queue`);
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`no time left of the pass's ${OUTBOX_REDIS_TIMEOUT_MS} ms`);
        await withTimeout(
          queue.addBulk(
            group.map((r) => ({
              name: r.job_name,
              data: r.data,
              opts: {
                ...(QUEUE_JOB_DEFAULTS as JobsOptions),
                ...outboxJobOptions(r.job_name),
                jobId: r.job_id,
                delay: r.run_at ? Math.max(0, r.run_at.getTime() - now) : 0,
              },
            })),
          ),
          left,
          `addBulk to ${name}`,
        );
        delivered.push(...ids);
      } catch (e) {
        firstError = errMsg(e);
        failed.push({ ids, error: firstError.slice(0, MAX_ERROR_LENGTH) });
      }
    }
    if (delivered.length > 0)
      await this.db.deleteFrom("outbox").where("id", "in", delivered).execute();
    return { sent: delivered.length, failed };
  }

  /**
   * Records a failed add on its rows (after the claim transaction, so the attempt is kept whatever
   * that transaction did): one more attempt, the error, the next attempt by {@link OUTBOX_BACKOFF},
   * and `dead_at` at the last attempt. Returns how many rows it made dead.
   */
  private async recordFailure(group: FailedGroup): Promise<number> {
    const { baseMs, capMs, maxAttempts } = OUTBOX_BACKOFF;
    // the right-hand sides read the row before the update: the first failure waits baseMs
    const backoffMs = sql`least(${capMs}::float8, ${baseMs}::float8 * power(2, attempts))`;
    const updated = await this.db
      .updateTable("outbox")
      .set({
        attempts: sql`attempts + 1`,
        last_error: group.error,
        next_attempt_at: sql`now() + ${backoffMs} * interval '1 millisecond'`,
        dead_at: sql`case when attempts + 1 >= ${maxAttempts}::int then now() end`,
      })
      .where("id", "in", group.ids)
      .where("dead_at", "is", null)
      .returning(["dead_at"])
      .execute();
    const dead = updated.filter((r) => r.dead_at !== null).length;
    this.log.warn("outbox delivery failed; retrying with backoff", {
      rows: group.ids.length,
      dead,
      error: group.error,
    });
    if (dead > 0) {
      this.log.error("outbox rows dead after the last attempt", { rows: dead, error: group.error });
    }
    return dead;
  }
}
