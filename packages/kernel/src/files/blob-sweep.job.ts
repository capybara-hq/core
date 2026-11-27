import type { ObjectHead } from "@capybara-hq/plugin-sdk";
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
import { revokeSharesIn } from "../shares/revoke.js";
import { StorageService } from "../storage/storage.service.js";
import { oweBlobDelete } from "./blob-objects.js";
import { blobContentMatches } from "./blobs.service.js";
import { FileLibraryBackfill } from "./library-backfill.js";

/** The daily blob sweep's name (scheduler key and lock; no `:`). */
export const BLOB_SWEEP_JOB = "blob-sweep";

/** When the daily blob sweep runs (the deployment's time zone): after the share sweep (03:40). */
export const BLOB_SWEEP_CRON = "20 4 * * *";

/** A `ready` (or `gone`) blob nothing refers to is released once it is older than this (hours). */
export const UNREFERENCED_AFTER_HOURS = 24;

/** A `pending` blob with no file is abandoned once it is older than this (hours). */
export const PENDING_AFTER_HOURS = 1;

/**
 * A `deleting` blob created more than this many hours ago is reconciled: its deletion is owed
 * again when nothing refers to it (deduplicated by its job id while the first deletion still
 * waits, e.g. a merge's deferred one), it is restored when something does. The age is the blob's
 * `created_at` (no column records when it became `deleting`); a blob whose deletion already
 * claimed it is `gone`, never `deleting`, so a restore never races its object's deletion.
 */
export const STALE_DELETING_AFTER_HOURS = 24;

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
  /** Stale `deleting` blobs nothing refers to whose deletion was owed again. */
  deletionsReowed: number;
  /** Stale `deleting` blobs something still refers to, back to `ready` (or `gone`). */
  deletingRestored: number;
}

/** Which blobs a release pass takes: their statuses and the age they must have reached. */
interface ReleaseKind {
  statuses: readonly BlobStatus[];
  olderThanHours: number;
  /** Only blobs with a sha256 (while the catch-up copy has not settled; see the class comment). */
  hashedOnly?: boolean;
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
 *    settled) likewise;
 * 4. `deleting` blobs older than {@link STALE_DELETING_AFTER_HOURS} are reconciled: one nothing
 *    refers to has its deletion owed again (the job may have run out of attempts); one something
 *    refers to (only `file_library_copy` inserts a reference without `BlobsService.lockReady`, and
 *    the deletion job refuses a referenced blob before touching its bytes) is restored: `ready`
 *    when its object is still the recorded bytes, else `gone`.
 *
 * Until the catch-up copy settled ({@link FileLibraryBackfill.settled}) step 2 leaves unhashed
 * (migrated) blobs alone: the copy may still point new files or shares at them.
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
    @Inject(StorageService) private readonly storage: Pick<StorageService, "kernel">,
    @Inject(FileLibraryBackfill) private readonly backfill: Pick<FileLibraryBackfill, "settled">,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedCron(BLOB_SWEEP_CRON, { name: BLOB_SWEEP_JOB })
  async sweep(signal?: AbortSignal): Promise<void> {
    const r = await this.runOnce(signal);
    if (Object.values(r).some((n) => n > 0)) {
      this.log.info("blob sweep done", { ...r });
    }
  }

  /** One sweep without the tick lock (the cron body; tests call it directly). */
  async runOnce(signal?: AbortSignal): Promise<BlobSweepResult> {
    const r: BlobSweepResult = {
      filesDeleted: 0,
      blobsReleased: 0,
      pendingReleased: 0,
      deletionsReowed: 0,
      deletingRestored: 0,
    };
    const unreferencedKind: ReleaseKind = (await this.backfill.settled())
      ? UNREFERENCED
      : { ...UNREFERENCED, hashedOnly: true };
    let after: string | null = null;
    while (!signal?.aborted) {
      const orgs = await this.orgPage(after);
      for (const orgId of orgs) {
        if (signal?.aborted) return r;
        await withOrgScope(orgId, () => this.sweepOrg(orgId, unreferencedKind, r, signal));
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

  /** The four steps for one org (in its scope). */
  private async sweepOrg(
    orgId: string,
    unreferencedKind: ReleaseKind,
    r: BlobSweepResult,
    signal?: AbortSignal,
  ): Promise<void> {
    for (;;) {
      if (signal?.aborted) return;
      const n = await this.deleteExpiredFiles(orgId);
      r.filesDeleted += n;
      if (n < BATCH) break;
    }
    r.blobsReleased += await this.releaseAll(orgId, unreferencedKind, signal);
    r.pendingReleased += await this.releaseAll(orgId, ABANDONED, signal);
    let after: string | null = null;
    while (!signal?.aborted) {
      const batch = await this.reconcileDeleting(orgId, after);
      r.deletionsReowed += batch.reowed;
      r.deletingRestored += batch.restored;
      if (batch.last === null) break;
      after = batch.last;
    }
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
   * transaction holds are skipped; the condition is checked again on the locked rows). Their shares
   * are revoked (`file_deleted`) in the same transaction, before the rows go and with them the
   * shares' `source_file_id` (defense in depth: deleting the file already revoked them).
   */
  @Transactional()
  async deleteExpiredFiles(orgId: string): Promise<number> {
    const trx = this.db.db;
    const days = this.config.get().files.deletedRetentionDays;
    const cutoff = sql<Date>`now() - make_interval(days => ${days})`;
    const claimed = await trx
      .selectFrom("files")
      .select("id")
      .where("org_id", "=", orgId)
      .where("status", "=", "deleted")
      .where("deleted_at", "<", cutoff)
      .orderBy("deleted_at")
      .limit(BATCH)
      .forUpdate()
      .skipLocked()
      .execute();
    if (claimed.length === 0) return 0;
    const ids = claimed.map((r) => r.id);
    await revokeSharesIn(trx, { orgId, fileIds: ids }, "file_deleted");
    const rows = await trx
      .deleteFrom("files")
      .where("org_id", "=", orgId)
      .where("id", "in", ids)
      .where("status", "=", "deleted")
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
      .$if(kind.hashedOnly === true, (q) => q.where("sha256", "is not", null))
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
      .$if(kind.hashedOnly === true, (q) => q.where("sha256", "is not", null))
      .returning("id")
      .execute();
    for (const b of released) await oweBlobDelete(this.outbox, orgId, b.id);
    return {
      released: released.length,
      last: candidates.length < BATCH ? null : (candidates.at(-1) as { id: string }).id,
    };
  }

  /**
   * Step 4, one batch of up to {@link BATCH} stale `deleting` blobs after `after`: the objects of
   * the referenced ones are checked first (outside any transaction), then one transaction locks the
   * batch `FOR UPDATE SKIP LOCKED`, checks the references again in a statement of its own, restores
   * the referenced ones and owes the deletion of the others again (deduplicated while it is owed).
   */
  private async reconcileDeleting(
    orgId: string,
    after: string | null,
  ): Promise<{ reowed: number; restored: number; last: string | null }> {
    const old = sql<Date>`now() - make_interval(hours => ${STALE_DELETING_AFTER_HOURS})`;
    const rows = await this.db
      .selectFrom("blobs")
      .select(["id", "object_key", "size", "etag"])
      .select((eb) => eb.not(unreferenced(orgId)(eb)).as("referenced"))
      .where("org_id", "=", orgId)
      .where("status", "=", "deleting")
      .where("created_at", "<", old)
      .$if(after !== null, (q) => q.where("id", ">", after as string))
      .orderBy("id")
      .limit(BATCH)
      .execute();
    if (rows.length === 0) return { reowed: 0, restored: 0, last: null };
    const intact = new Set<string>();
    const skipped = new Set<string>();
    for (const b of rows) {
      if (!b.referenced) continue;
      let head: ObjectHead | null;
      try {
        head = await this.storage.kernel(orgId).head(b.object_key);
      } catch (err) {
        // storage unavailable: left `deleting` for the next sweep; other blobs and orgs go on
        this.log.warn("cannot check a stale deleting blob's object; will retry", {
          orgId,
          blobId: b.id,
          err,
        });
        skipped.add(b.id);
        continue;
      }
      if (head && blobContentMatches({ size: Number(b.size), etag: b.etag }, head))
        intact.add(b.id);
    }
    const done = await this.settleDeleting(
      orgId,
      rows.filter((b) => !skipped.has(b.id)).map((b) => b.id),
      intact,
    );
    return { ...done, last: rows.length < BATCH ? null : (rows.at(-1) as { id: string }).id };
  }

  /** The transaction of {@link reconcileDeleting}. */
  @Transactional()
  async settleDeleting(
    orgId: string,
    ids: readonly string[],
    intact: ReadonlySet<string>,
  ): Promise<{ reowed: number; restored: number }> {
    if (ids.length === 0) return { reowed: 0, restored: 0 };
    const trx = this.db.db;
    const locked = await trx
      .selectFrom("blobs")
      .select("id")
      .where("org_id", "=", orgId)
      .where("id", "in", [...ids])
      .where("status", "=", "deleting")
      .forUpdate()
      .skipLocked()
      .execute();
    if (locked.length === 0) return { reowed: 0, restored: 0 };
    // a statement of its own: sees every reference committed before the rows were locked
    const free = await trx
      .selectFrom("blobs")
      .select("id")
      .where("org_id", "=", orgId)
      .where(
        "id",
        "in",
        locked.map((b) => b.id),
      )
      .where(unreferenced(orgId))
      .execute();
    const freeIds = new Set(free.map((b) => b.id));
    for (const id of freeIds) await oweBlobDelete(this.outbox, orgId, id);
    let restored = 0;
    for (const { id } of locked) {
      if (freeIds.has(id)) continue;
      // referenced: the deletion job refuses it before touching its bytes; a missing or changed
      // object (a deletion that raced the reference) is `gone`, as reads would treat it
      await trx
        .updateTable("blobs")
        .set({ status: intact.has(id) ? "ready" : "gone" })
        .where("id", "=", id)
        .where("org_id", "=", orgId)
        .where("status", "=", "deleting")
        .execute();
      restored += 1;
    }
    return { reowed: freeIds.size, restored };
  }
}
