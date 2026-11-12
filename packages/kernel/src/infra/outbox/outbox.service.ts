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
  /** Deterministic, no `:`; one pending row per (queue, jobId). */
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

/**
 * The ids each open transaction inserted, keyed by its transaction store: lives only as long as
 * that transaction (a WeakMap entry, no state shared across requests).
 */
const pendingIds = new WeakMap<object, string[]>();

/**
 * Writes owed work as a row in the caller's transaction (spec §3.2): the row commits or rolls back
 * with the business write, and after the commit the fast path delivers it.
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
   * it inserted a row, false when the same (queue, jobId) is already owed (a no-op). A conflict whose
   * stored data differs is a bug in the job id: it throws under strict conflicts, else logs an error.
   */
  @Transactional({ propagation: "mandatory" })
  async add<T>(job: OutboxJob<T>): Promise<boolean> {
    const json = JSON.stringify(job.data);
    const row = await this.db
      .insertInto("outbox")
      .values({
        queue: job.queue,
        job_name: job.name,
        job_id: job.jobId,
        data: json,
        run_at: job.runAt ?? null,
        org_id: job.orgId ?? null,
      })
      .onConflict((oc) => oc.columns(["queue", "job_id"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (row) {
      this.deliverAfterCommit(row.id);
      return true;
    }
    const stored = await this.db
      .selectFrom("outbox")
      .select(["job_name", "data"])
      .where("queue", "=", job.queue)
      .where("job_id", "=", job.jobId)
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
