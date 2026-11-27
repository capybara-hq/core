import { Inject, Injectable } from "@nestjs/common";
import { type ExpressionBuilder, sql } from "kysely";
import type { BlobStatus, KernelDatabase } from "../db/kernel-schema.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { asPlatform, withOrgScope } from "../infra/database/org-scope.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { oweBlobDelete } from "./blob-objects.js";

/** The daily blob sweep's name (scheduler key and lock; no `:`). */
export const BLOB_SWEEP_JOB = "blob-sweep";

/** When the daily blob sweep runs (the deployment's time zone): after the share sweep (03:40). */
export const BLOB_SWEEP_CRON = "20 4 * * *";

/** A `ready` (or `gone`) blob nothing refers to is released once it is older than this (hours). */
export const UNREFERENCED_AFTER_HOURS = 24;

/** A `pending` blob with no file is abandoned once it is older than this (hours). */
export const PENDING_AFTER_HOURS = 1;

/** Rows per batch (one transaction per batch). */
const BATCH = 200;
/** Orgs per lookup. */
const ORG_PAGE = 500;

/** What one sweep did (logged; returned for tests). */
export interface BlobSweepResult {
  /** `deleted` files past the retention whose rows were deleted. */
  filesDeleted: number;
  /** `ready` / `gone` blobs nothing refers to that became `deleting`. */
  blobsReleased: number;
  /** Abandoned `pending` blobs that became `deleting`. */
  pendingReleased: number;
}

/** Which blobs a release pass takes: their statuses and the age they must have reached. */
interface ReleaseKind {
  statuses: readonly BlobStatus[];
  olderThanHours: number;
}

const UNREFERENCED: ReleaseKind = {
  statuses: ["ready", "gone"],
  olderThanHours: UNREFERENCED_AFTER_HOURS,
};
const ABANDONED: ReleaseKind = { statuses: ["pending"], olderThanHours: PENDING_AFTER_HOURS };

/**
 * No file row (any status: a `deleted` one within the retention keeps its bytes, and the rows past
 * it are deleted first by the same sweep) and no share (`file_shares.blob_id`: the share sweep
 * clears it on shares long expired or revoked) refers to the blob.
 */
function unreferenced(orgId: string) {
  return (eb: ExpressionBuilder<KernelDatabase, "blobs">) =>
    eb.and([
      eb.not(
        eb.exists(
          eb
            .selectFrom("files")
            .select("files.id")
            .where("files.org_id", "=", orgId)
            .whereRef("files.blob_id", "=", "blobs.id"),
        ),
      ),
      eb.not(
        eb.exists(
          eb
            .selectFrom("file_shares")
            .select("file_shares.id")
            .where("file_shares.org_id", "=", orgId)
            .whereRef("file_shares.blob_id", "=", "blobs.id"),
        ),
      ),
    ]);
}

/**
 * The daily blob sweep (file library spec §7), a `@LockedCron` (once per tick across replicas,
 * provided only under `WorkerModule`). For each live org, in the org's scope:
 *
 * 1. `deleted` files whose `deleted_at` is older than `files.deletedRetentionDays` lose their rows
 *    (their `conversation_files` rows go with them; logs keep the refs and render the placeholder);
 * 2. `ready` (and `gone`) blobs older than {@link UNREFERENCED_AFTER_HOURS} that no file row and no
 *    share refers to become `deleting`, their deletion owed (`blob-delete-<id>`) in the same
 *    transaction;
 * 3. `pending` blobs older than {@link PENDING_AFTER_HOURS} with no file (a kernel write that never
 *    settled) likewise.
 *
 * A claim locks its candidates `FOR UPDATE SKIP LOCKED` (a blob another transaction is pointing a
 * reference at holds `FOR SHARE` through `BlobsService.lockReady` and is skipped), then sets
 * `deleting` in a statement of its own that checks the references again: its fresh snapshot sees
 * every reference committed before the rows were locked, and once they are locked a new reference
 * waits and then finds the blob no longer `ready`. The `blob-delete` handler checks once more before
 * deleting anything. Nothing is kept in process memory; a run that stops midway is finished by the
 * next one. Deleted orgs are skipped (their objects go with `storage-org-purge`).
 */
@Injectable()
export class BlobSweepJob {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedCron(BLOB_SWEEP_CRON, { name: BLOB_SWEEP_JOB })
  async sweep(signal?: AbortSignal): Promise<void> {
    const r = await this.runOnce(signal);
    if (r.filesDeleted + r.blobsReleased + r.pendingReleased > 0) {
      this.log.info("blob sweep done", { ...r });
    }
  }

  /** One sweep without the tick lock (the cron body; tests call it directly). */
  async runOnce(signal?: AbortSignal): Promise<BlobSweepResult> {
    const r: BlobSweepResult = { filesDeleted: 0, blobsReleased: 0, pendingReleased: 0 };
    let after: string | null = null;
    while (!signal?.aborted) {
      const orgs = await this.orgPage(after);
      for (const orgId of orgs) {
        if (signal?.aborted) return r;
        await withOrgScope(orgId, () => this.sweepOrg(orgId, r, signal));
      }
      if (orgs.length < ORG_PAGE) break;
      after = orgs.at(-1) as string;
    }
    return r;
  }

  /** A page of live org ids after `after`. */
  private orgPage(after: string | null): Promise<string[]> {
    return asPlatform("blob sweep: the live orgs to sweep", async () => {
      const rows = await this.db
        .selectFrom("orgs")
        .select("id")
        .where("deleted_at", "is", null)
        .$if(after !== null, (q) => q.where("id", ">", after as string))
        .orderBy("id")
        .limit(ORG_PAGE)
        .execute();
      return rows.map((o) => o.id);
    });
  }

  /** The three steps for one org (in its scope). */
  private async sweepOrg(orgId: string, r: BlobSweepResult, signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) return;
      const n = await this.deleteExpiredFiles(orgId);
      r.filesDeleted += n;
      if (n < BATCH) break;
    }
    r.blobsReleased += await this.releaseAll(orgId, UNREFERENCED, signal);
    r.pendingReleased += await this.releaseAll(orgId, ABANDONED, signal);
  }

  /** Step 2 or 3 for one org, batch by batch along the blob ids. */
  private async releaseAll(
    orgId: string,
    kind: ReleaseKind,
    signal?: AbortSignal,
  ): Promise<number> {
    let released = 0;
    let after: string | null = null;
    while (!signal?.aborted) {
      const batch = await this.releaseBatch(orgId, kind, after);
      released += batch.released;
      if (batch.last === null) break;
      after = batch.last;
    }
    return released;
  }

  /**
   * Step 1, one batch: deletes up to {@link BATCH} `deleted` files past the retention (rows another
   * transaction holds are skipped; the condition is checked again on the locked rows).
   */
  @Transactional()
  async deleteExpiredFiles(orgId: string): Promise<number> {
    const trx = this.db.db;
    const days = this.config.get().files.deletedRetentionDays;
    const cutoff = sql<Date>`now() - make_interval(days => ${days})`;
    const rows = await trx
      .deleteFrom("files")
      .where("org_id", "=", orgId)
      .where("status", "=", "deleted")
      .where("deleted_at", "<", cutoff)
      .where("id", "in", (eb) =>
        eb
          .selectFrom("files as f")
          .select("f.id")
          .where("f.org_id", "=", orgId)
          .where("f.status", "=", "deleted")
          .where("f.deleted_at", "<", cutoff)
          .orderBy("f.deleted_at")
          .limit(BATCH)
          .forUpdate()
          .skipLocked(),
      )
      .returning("id")
      .execute();
    return rows.length;
  }

  /**
   * Steps 2 and 3, one batch: claims up to {@link BATCH} candidates after `after` (see the class
   * comment), turns the still unreferenced ones `deleting` and owes their deletions. `last` is the
   * last candidate id (the next batch's cursor), null when there were no more candidates.
   */
  @Transactional()
  async releaseBatch(
    orgId: string,
    kind: ReleaseKind,
    after: string | null,
  ): Promise<{ released: number; last: string | null }> {
    const trx = this.db.db;
    const old = sql<Date>`now() - make_interval(hours => ${kind.olderThanHours})`;
    const candidates = await trx
      .selectFrom("blobs")
      .select("id")
      .where("org_id", "=", orgId)
      .where("status", "in", [...kind.statuses])
      .where("created_at", "<", old)
      .where(unreferenced(orgId))
      .$if(after !== null, (q) => q.where("id", ">", after as string))
      .orderBy("id")
      .limit(BATCH)
      .forUpdate()
      .skipLocked()
      .execute();
    if (candidates.length === 0) return { released: 0, last: null };
    // a statement of its own (READ COMMITTED: a fresh snapshot): a reference committed after the
    // claim's snapshot but before its row lock is seen here and keeps the blob
    const released = await trx
      .updateTable("blobs")
      .set({ status: "deleting" })
      .where("org_id", "=", orgId)
      .where(
        "id",
        "in",
        candidates.map((c) => c.id),
      )
      .where("status", "in", [...kind.statuses])
      .where(unreferenced(orgId))
      .returning("id")
      .execute();
    for (const b of released) await oweBlobDelete(this.outbox, orgId, b.id);
    return {
      released: released.length,
      last: candidates.length < BATCH ? null : (candidates.at(-1) as { id: string }).id,
    };
  }
}
