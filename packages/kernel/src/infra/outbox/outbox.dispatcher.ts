import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { JobsOptions, Queue } from "bullmq";
import { sql } from "kysely";
import type { KernelLogger } from "../../log.js";
import { KernelDb } from "../database/kernel-db.js";
import { TransactionHost } from "../database/transaction-host.js";
import { Transactional } from "../database/transactional.decorator.js";
import { QUEUE_JOB_DEFAULTS } from "../queue/queue.module.js";
import type { KernelQueueName } from "../queue/queue-names.js";
import { KERNEL_LOGGER } from "../tokens.js";

/**
 * Retry schedule of a row whose add failed (spec §3.4): the next attempt waits
 * `min(capMs, baseMs * 2^attempts)`, and the row is dead (kept, never retried) at `maxAttempts`.
 */
export const OUTBOX_BACKOFF = { baseMs: 1000, capMs: 300_000, maxAttempts: 20 } as const;

/** How long one `addBulk` may take while the claim transaction holds the rows' locks. */
export const OUTBOX_REDIS_TIMEOUT_MS = 2000;

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

/** Longest `last_error` kept on a row. */
const MAX_ERROR_LENGTH = 2000;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
 * queue with `addBulk` (the row's job id, a future `run_at` as the remaining `delay`), and deletes
 * the delivered rows in the same short transaction. A crash after the add and before the commit
 * leaves the rows; the next pass adds again and BullMQ ignores the existing job id. A queue whose
 * add fails keeps its rows, and a second short update records the attempt with exponential
 * backoff, setting `dead_at` at the last one.
 */
@Injectable()
export class OutboxDispatcher {
  private readonly queues: Record<KernelQueueName, Pick<Queue, "addBulk">>;

  constructor(
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(getQueueToken("cap-kernel-runs")) runs: Pick<Queue, "addBulk">,
    @Inject(getQueueToken("cap-kernel-subagent-runs")) subagentRuns: Pick<Queue, "addBulk">,
    @Inject(getQueueToken("cap-kernel-channels")) channels: Pick<Queue, "addBulk">,
    @Inject(getQueueToken("cap-kernel-maintenance")) maintenance: Pick<Queue, "addBulk">,
    @Inject(getQueueToken("cap-kernel-plugin-scope")) pluginScope: Pick<Queue, "addBulk">,
    @Inject(getQueueToken("cap-kernel-titles")) titles: Pick<Queue, "addBulk">,
    @Inject(getQueueToken("cap-kernel-usage-report")) usageReport: Pick<Queue, "addBulk">,
    @Inject(getQueueToken("cap-kernel-evals")) evals: Pick<Queue, "addBulk">,
    @Optional()
    @Inject(OUTBOX_DISPATCH_FAILS)
    private readonly dispatchFails: () => boolean = () => false,
  ) {
    this.queues = {
      "cap-kernel-runs": runs,
      "cap-kernel-subagent-runs": subagentRuns,
      "cap-kernel-channels": channels,
      "cap-kernel-maintenance": maintenance,
      "cap-kernel-plugin-scope": pluginScope,
      "cap-kernel-titles": titles,
      "cap-kernel-usage-report": usageReport,
      "cap-kernel-evals": evals,
    };
  }

  /**
   * The fast path: delivers the given rows (a committed transaction's own) right away. Never
   * throws: whatever it does not deliver stays for the relay, and a failure is logged.
   */
  async dispatchOwn(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await this.dispatch({ ids });
    } catch (e) {
      this.log.error("outbox fast path failed; the relay delivers the rows", {
        rows: ids.length,
        error: errMsg(e),
      });
    }
  }

  /** The relay: delivers up to `limit` due rows (not dead, `next_attempt_at` reached), oldest first. */
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
   * kernel (spec §3.3): the locks held are outbox rows only, and each add is bounded by
   * {@link OUTBOX_REDIS_TIMEOUT_MS}.
   */
  @Transactional({ propagation: "requires_new" })
  private async claimAndSend(claim: Claim): Promise<{ sent: number; failed: FailedGroup[] }> {
    let query = this.db
      .selectFrom("outbox")
      .select(["id", "queue", "job_name", "job_id", "data", "run_at"])
      .where("dead_at", "is", null);
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
    const delivered: string[] = [];
    const failed: FailedGroup[] = [];
    for (const [name, group] of byQueue) {
      const ids = group.map((r) => r.id);
      try {
        if (this.dispatchFails()) throw new Error("outbox dispatch failure (test seam)");
        const queue = this.queues[name as KernelQueueName];
        if (!queue) throw new Error(`"${name}" is not a kernel queue`);
        await withTimeout(
          queue.addBulk(
            group.map((r) => ({
              name: r.job_name,
              data: r.data,
              opts: {
                ...(QUEUE_JOB_DEFAULTS as JobsOptions),
                jobId: r.job_id,
                delay: r.run_at ? Math.max(0, r.run_at.getTime() - now) : 0,
              },
            })),
          ),
          OUTBOX_REDIS_TIMEOUT_MS,
          `addBulk to ${name}`,
        );
        delivered.push(...ids);
      } catch (e) {
        failed.push({ ids, error: errMsg(e).slice(0, MAX_ERROR_LENGTH) });
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
    const updated = await this.db
      .updateTable("outbox")
      .set({
        attempts: sql`attempts + 1`,
        last_error: group.error,
        next_attempt_at: sql`now() + least(${capMs}::float8, ${baseMs}::float8 * power(2, attempts)) * interval '1 millisecond'`,
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
