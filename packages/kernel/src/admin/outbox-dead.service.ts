import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import type { WriteActor } from "../identity/write-actor.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OUTBOX_FAST_PATH, type OutboxFastPath } from "../infra/outbox/outbox.service.js";

/** The most dead rows `GET /api/v1/admin/outbox/dead` returns, oldest first. */
export const OUTBOX_DEAD_LIST_MAX = 200;

/** A dead outbox row as the super admin sees it (transactional outbox spec §3.4). */
export interface OutboxDeadRow {
  id: string;
  queue: string;
  jobName: string;
  jobId: string;
  /** The org the work belongs to; null for platform work (or an org deleted since). */
  orgId: string | null;
  attempts: number;
  lastError: string | null;
  deadAt: string;
  createdAt: string;
}

/** Dead rows in all: how many and since when (the overview's `outbox_dead` attention item). */
export interface OutboxDeadSummary {
  count: number;
  oldestAt: Date | null;
}

/**
 * What a retry did: `retried` (the row is due again, the relay delivers it) or `already_owed`
 * (the same job is owed by a pending row already, so the dead copy was discarded: ruling R8).
 */
export type OutboxRetryOutcome = "retried" | "already_owed";

/** The unique index of pending rows (0119): one pending row per (queue, job_id). */
const PENDING_UNIQUE = "outbox_job_uniq";

const isPendingConflict = (e: unknown): boolean =>
  typeof e === "object" &&
  e !== null &&
  (e as { code?: unknown }).code === "23505" &&
  (e as { constraint?: unknown }).constraint === PENDING_UNIQUE;

const notFound = (id: string) =>
  new ApiError(
    "outbox.not_found",
    `No dead outbox row ${id}; list them with GET /api/v1/admin/outbox/dead`,
  );

/**
 * The super admin's dead outbox rows (transactional outbox spec §3.4): the rows the dispatcher
 * gave up on after its last attempt. Nothing is dropped silently: a row stays until a super admin
 * retries it (it is due again with fresh attempts) or discards it, each audited at platform level
 * (`outbox.retried`, `outbox.discarded`). A retry does not look at what the job is about: every
 * job name added through the outbox is harmless when its work is gone or done (spec §3.5).
 */
@Injectable()
export class OutboxDeadService {
  constructor(
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(OUTBOX_FAST_PATH) private readonly fastPath: OutboxFastPath,
  ) {}

  /** The dead rows, oldest first, at most {@link OUTBOX_DEAD_LIST_MAX}. */
  async list(): Promise<{ items: OutboxDeadRow[] }> {
    const rows = await this.db.db
      .selectFrom("outbox")
      .select([
        "id",
        "queue",
        "job_name",
        "job_id",
        "org_id",
        "attempts",
        "last_error",
        "dead_at",
        "created_at",
      ])
      .where("dead_at", "is not", null)
      .orderBy("dead_at")
      .orderBy("id")
      .limit(OUTBOX_DEAD_LIST_MAX)
      .execute();
    return {
      items: rows.map((r) => ({
        id: String(r.id),
        queue: r.queue,
        jobName: r.job_name,
        jobId: r.job_id,
        orgId: r.org_id,
        attempts: r.attempts,
        lastError: r.last_error,
        deadAt: (r.dead_at as Date).toISOString(),
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  /** How many rows are dead, and the oldest one's `dead_at`. */
  async summary(): Promise<OutboxDeadSummary> {
    const row = await this.db.db
      .selectFrom("outbox")
      .select([sql<string>`count(*)`.as("count"), sql<Date | null>`min(dead_at)`.as("oldest")])
      .where("dead_at", "is not", null)
      .executeTakeFirstOrThrow();
    return { count: Number(row.count), oldestAt: row.oldest };
  }

  /**
   * Makes a dead row due again (`dead_at` cleared, no attempts, next attempt now) and hands it to
   * the fast path after the commit; the relay delivers it otherwise. When the same (queue, job id)
   * is owed by a pending row already, the dead row is deleted instead (`already_owed`). A pending
   * row added between the check and the update fails the update on the unique index: the retry
   * then runs once more and takes the `already_owed` branch; a second conflict on that run (the
   * job owed, delivered and owed again meanwhile) is `conflict` (409), the dead row left as it was.
   * `outbox.not_found` (404) when no dead row has the id.
   */
  async retry(
    id: string,
    actor: WriteActor,
    detail: Record<string, unknown> = {},
  ): Promise<{ outcome: OutboxRetryOutcome }> {
    try {
      return await this.retryOnce(id, actor, detail);
    } catch (e) {
      if (!isPendingConflict(e)) throw e;
    }
    try {
      return await this.retryOnce(id, actor, detail);
    } catch (e) {
      if (!isPendingConflict(e)) throw e;
      throw new ApiError(
        "conflict",
        `The job of dead outbox row ${id} was owed again while it was retried; list the dead rows with GET /api/v1/admin/outbox/dead and retry or discard it again`,
      );
    }
  }

  @Transactional()
  private async retryOnce(
    id: string,
    actor: WriteActor,
    detail: Record<string, unknown>,
  ): Promise<{ outcome: OutboxRetryOutcome }> {
    const row = await this.lockDead(id);
    const owed = await this.db.db
      .selectFrom("outbox")
      .select("id")
      .where("queue", "=", row.queue)
      .where("job_id", "=", row.job_id)
      .where("dead_at", "is", null)
      .executeTakeFirst();
    let outcome: OutboxRetryOutcome;
    if (owed) {
      await this.db.db.deleteFrom("outbox").where("id", "=", id).execute();
      outcome = "already_owed";
    } else {
      await this.db.db
        .updateTable("outbox")
        .set({ dead_at: null, attempts: 0, next_attempt_at: sql<Date>`now()` })
        .where("id", "=", id)
        .execute();
      outcome = "retried";
      afterCommit(() => this.fastPath([id]));
    }
    await this.audit("outbox.retried", id, row, actor, { ...detail, outcome });
    return { outcome };
  }

  /** Deletes a dead row: its job is never delivered. `outbox.not_found` (404) when none. */
  @Transactional()
  async discard(
    id: string,
    actor: WriteActor,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    const row = await this.lockDead(id);
    await this.db.db.deleteFrom("outbox").where("id", "=", id).execute();
    await this.audit("outbox.discarded", id, row, actor, detail);
  }

  /** The dead row `id`, locked for the transaction; `outbox.not_found` when it is not dead. */
  private async lockDead(id: string) {
    const row = await this.db.db
      .selectFrom("outbox")
      .select(["queue", "job_name", "job_id", "org_id", "attempts", "last_error"])
      .where("id", "=", id)
      .where("dead_at", "is not", null)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw notFound(id);
    return row;
  }

  /**
   * A platform-level audit event (no org: the outbox is the deployment's), naming the job. The
   * caller's detail (`via`, `operation`) comes first, so it cannot override the row's fields.
   */
  private audit(
    action: "outbox.retried" | "outbox.discarded",
    id: string,
    row: { queue: string; job_name: string; job_id: string; org_id: string | null },
    actor: WriteActor,
    detail: Record<string, unknown>,
  ): Promise<void> {
    return audit(this.db.db, {
      actorAccountId: actor.accountId,
      ...(actor.tokenId !== undefined && { actorTokenId: actor.tokenId }),
      action,
      target: id,
      detail: {
        ...detail,
        queue: row.queue,
        jobName: row.job_name,
        jobId: row.job_id,
        ...(row.org_id !== null && { orgId: row.org_id }),
      },
    });
  }
}
