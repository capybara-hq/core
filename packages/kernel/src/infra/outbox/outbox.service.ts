import { isDeepStrictEqual } from "node:util";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { KernelLogger } from "../../log.js";
import { afterCommit } from "../database/after-commit.js";
import { KernelDb } from "../database/kernel-db.js";
import { currentStore, TransactionHost } from "../database/transaction-host.js";
import { Transactional } from "../database/transactional.decorator.js";
import type { KernelQueueName } from "../queue/queue-names.js";
import { KERNEL_LOGGER } from "../tokens.js";
import type { OutboxJobName } from "./registry.js";

/** A BullMQ job owed by the caller's transaction (transactional outbox spec §5). */
export interface OutboxJob<T> {
  /** One of the kernel queues. */
  queue: KernelQueueName;
  /** A registered job name ({@link OutboxJobName}). */
  name: OutboxJobName;
  /** Deterministic, no `:`; one pending (not dead) row per (queue, jobId). */
  jobId: string;
  /** JSON data: stored as jsonb, so what JSON cannot carry (undefined, Date objects) is lost. */
  data: T;
  /** Delay target: delivered as a BullMQ `delay` computed at dispatch. */
  runAt?: Date;
  /** The org the work belongs to (its deletion removes the pending row); absent for platform work. */
  orgId?: string;
}

/** Delivers the given outbox rows right after their transaction committed (the fast path, §3.3). */
export type OutboxFastPath = (ids: readonly string[]) => Promise<void>;

/** The fast path `add` hands each committed transaction's rows to (`OutboxModule` provides it). */
export const OUTBOX_FAST_PATH = Symbol("OUTBOX_FAST_PATH");

/**
 * Test seam (`KernelOverride`): `true` makes a reused job id with different data throw instead of
 * logging an error (spec §4, designer's call: "throws in tests, logs in production").
 */
export const OUTBOX_STRICT_CONFLICTS = Symbol("OUTBOX_STRICT_CONFLICTS");

/** Jobs per insert statement of {@link OutboxService.addMany} (6 parameters each). */
const ADD_MANY_CHUNK = 1000;

/** The row of `job` (throws on a job id with `:`). */
function rowOf<T>(job: OutboxJob<T>) {
  if (job.jobId.includes(":")) {
    throw new Error(
      `outbox job id "${job.jobId}" must not contain ":" (BullMQ uses it as its key separator); ` +
        'join the id\'s parts with "-" instead',
    );
  }
  return {
    queue: job.queue,
    job_name: job.name,
    job_id: job.jobId,
    data: JSON.stringify(job.data ?? null),
    run_at: job.runAt ?? null,
    org_id: job.orgId ?? null,
  };
}

/**
 * Only a job due now goes through the fast path (ruling R20): a delayed one (a backstop, a
 * timeout) is claimed by the relay within its next tick and added with its remaining delay, so the
 * commit's caller spends no claim transaction on work due in seconds or hours.
 */
const dueNow = (job: { runAt?: Date | undefined }) =>
  job.runAt === undefined || job.runAt.getTime() <= Date.now();

/**
 * The ids each open transaction inserted, keyed by its transaction store: lives only as long as
 * that transaction (a WeakMap entry, no state shared across requests).
 */
const pendingIds = new WeakMap<object, string[]>();

/**
 * Writes owed work as a row in the caller's transaction (spec §3.2): the row commits or rolls back
 * with the business write, and after the commit the fast path delivers it when it is due now (a
 * row with a future `runAt` waits for the relay, spec §3.3).
 */
@Injectable()
export class OutboxService {
  constructor(
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(OUTBOX_FAST_PATH) private readonly fastPath: OutboxFastPath,
    @Optional()
    @Inject(OUTBOX_STRICT_CONFLICTS)
    private readonly strictConflicts: boolean = false,
  ) {}

  /**
   * Adds the job to the outbox in the transaction in context (throws outside one). Returns true when
   * it inserted a row, false when the same (queue, jobId) is already owed (a no-op; a dead row is
   * not owed). A conflict whose stored data differs is a bug in the job id: it throws under strict
   * conflicts, else logs an error. Undefined data is stored as JSON null.
   */
  @Transactional({ propagation: "mandatory" })
  async add<T>(job: OutboxJob<T>): Promise<boolean> {
    const json = JSON.stringify(job.data ?? null);
    const row = await this.db
      .insertInto("outbox")
      .values(rowOf(job))
      .onConflict((oc) => oc.columns(["queue", "job_id"]).where("dead_at", "is", null).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (row) {
      if (dueNow(job)) this.deliverAfterCommit(row.id);
      return true;
    }
    const stored = await this.db
      .selectFrom("outbox")
      .select(["job_name", "data"])
      .where("queue", "=", job.queue)
      .where("job_id", "=", job.jobId)
      .where("dead_at", "is", null)
      .executeTakeFirst();
    // no row: the owed one was delivered (and deleted) since the conflict; BullMQ dedupes the id
    if (stored && !isDeepStrictEqual(stored.data, JSON.parse(json))) {
      const msg = "outbox job id reused with different data";
      const fields = {
        queue: job.queue,
        jobId: job.jobId,
        job: job.name,
        owedJob: stored.job_name,
      };
      if (this.strictConflicts) throw new Error(`${msg}: ${JSON.stringify(fields)}`);
      this.log.error(msg, fields);
    }
    return false;
  }

  /**
   * {@link add} for many jobs in one multi-row insert per {@link ADD_MANY_CHUNK} jobs (an eval
   * run's cases). A job whose (queue, jobId) is already owed is skipped without comparing its data.
   * Returns how many rows it inserted.
   */
  @Transactional({ propagation: "mandatory" })
  async addMany<T>(jobs: readonly OutboxJob<T>[]): Promise<number> {
    let inserted = 0;
    for (let i = 0; i < jobs.length; i += ADD_MANY_CHUNK) {
      const chunk = jobs.slice(i, i + ADD_MANY_CHUNK);
      const rows = await this.db
        .insertInto("outbox")
        .values(chunk.map(rowOf))
        .onConflict((oc) =>
          oc.columns(["queue", "job_id"]).where("dead_at", "is", null).doNothing(),
        )
        .returning(["id", "run_at"])
        .execute();
      for (const r of rows) {
        if (dueNow({ runAt: r.run_at ?? undefined })) this.deliverAfterCommit(r.id);
      }
      inserted += rows.length;
    }
    return inserted;
  }

  /** Collects `id` for its transaction; the first id registers the transaction's one hint. */
  private deliverAfterCommit(id: string): void {
    // `mandatory` guarantees a live store here
    const store = currentStore();
    if (!store) throw new Error("outbox: no transaction in context");
    const ids = pendingIds.get(store);
    if (ids) {
      ids.push(id);
      return;
    }
    const first = [id];
    pendingIds.set(store, first);
    afterCommit(() => this.fastPath(first));
  }
}
