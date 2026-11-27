import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { asPlatform, withOrgScope } from "../infra/database/org-scope.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { LockedInterval } from "../infra/schedule/locked-interval.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { StorageService } from "../storage/storage.service.js";
import { oweBlobDelete } from "./blob-objects.js";
import { BlobHashLock, BlobsService, blobContentMatches } from "./blobs.service.js";
import { FileLibraryBackfill } from "./library-backfill.js";

/** The hashing dispatcher's job name and deterministic id (no `:`). */
export const FILE_LIBRARY_HASH_JOB = "file-library-hash";

/** The job name of one org's hashing batch. */
export const FILE_LIBRARY_HASH_ORG_JOB = "file-library-hash-org";

/** The hourly kickoff's name (scheduler key and lock; no `:`). */
export const FILE_LIBRARY_KICKOFF_JOB = "file-library-kickoff";

/** The kickoff's period. */
export const FILE_LIBRARY_KICKOFF_PERIOD_MS = 60 * 60_000;

/** Blobs one org batch hashes before it owes the next batch. */
export const HASH_BATCH = 50;

/**
 * How long after a merge the duplicate's deletion runs: reads that resolved the old blob just
 * before the merge (a stream, a short-lived link) finish first.
 */
export const MERGE_DELETE_DELAY_MS = 60 * 60_000;

/** The longest the read of one blob may take (ms); a store that stalls longer is tried later. */
export const HASH_READ_TIMEOUT_MS = 10 * 60_000;

/** The lock of one org's hashing (no `:`): one batch chain per org at a time. */
const orgLockKey = (orgId: string) => `file-library-hash-${orgId}`;

/** The lock's lifetime without renewal (renewed while the batch runs). */
const ORG_LOCK_TTL_MS = 60_000;

/** Deterministic id of one org's batch starting after blob `after` (no `:`). */
export const fileLibraryHashOrgJobId = (orgId: string, after: string | null): string =>
  `file-library-hash-${orgId}-${after ?? "first"}`;

/** The data of a {@link FILE_LIBRARY_HASH_ORG_JOB}. */
export interface HashOrgData {
  orgId: string;
  /** The cursor: the batch takes blobs with an id after it (null: from the start). */
  after: string | null;
}

/** What hashing one blob did. */
export type HashOutcome = "hashed" | "merged" | "gone" | "skipped";

/** What one org batch did (returned for tests). */
export interface HashBatchResult {
  /** False when another chain held the org's lock or the copy had not settled. */
  ran: boolean;
  outcomes: Partial<Record<HashOutcome | "failed", number>>;
  /** The cursor of the next batch owed, null when none. */
  next: string | null;
}

/** An unhashed blob as the batch reads it. */
interface UnhashedBlob {
  id: string;
  object_key: string;
  size: string | number;
  etag: string | null;
}

/**
 * The hashing of migrated blobs (file library spec §9 step 2): every blob the kernel writes gets
 * its sha256 when it settles, so the blobs with none are those 0189/0190 (and the catch-up copy)
 * migrated. Resumable and multi-replica safe:
 *
 * - the dispatcher job `file-library-hash` (deterministic id) owes one batch job per org that has
 *   unhashed `ready` blobs, `file-library-hash-<orgId>-first`;
 * - an org batch (`file-library-hash-<orgId>-<after>`, in the org's scope through `runJob`) holds
 *   the org's lock (one chain per org; a second chain stops at once), takes up to
 *   {@link HASH_BATCH} blobs with `sha256 IS NULL AND status = 'ready' AND dedup_after <= now()`
 *   by id after its cursor, hashes them one by one, releases the lock, then owes the next batch;
 * - per blob: the object is read without the size check, but its head must match the row (size,
 *   and the etag when one was recorded; migrated artifacts and shares have none) or the blob is
 *   `gone`, as reads already treat it; a missing object is `gone` too (its files render the
 *   placeholder). Then, in one transaction under the hash's lock ({@link BlobHashLock}), the hash is
 *   set when no other blob holds it (a holder no longer `ready` gives it up); else, only when the
 *   holder is `ready` and dedupable (`dedup_after <= now()`), the files and shares are repointed to
 *   the holder (locked through `BlobsService.lockReady`), this blob becomes `deleting` and its
 *   deletion is owed (deferred {@link MERGE_DELETE_DELAY_MS}). Anything else leaves the blob for a
 *   later pass. A file keeps the reference it was first stored under (`ref_key` / `ref_etag`).
 *
 * Nothing merges before the catch-up copy settled ({@link FileLibraryBackfill.settled}).
 */
@Injectable()
export class FileLibraryHashJob {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(StorageService) private readonly storage: Pick<StorageService, "kernel">,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add" | "addMany">,
    @Inject(BlobHashLock) private readonly hashLock: Pick<BlobHashLock, "lock">,
    @Inject(BlobsService) private readonly blobs: Pick<BlobsService, "lockReady">,
    @Inject(FileLibraryBackfill) private readonly backfill: Pick<FileLibraryBackfill, "settled">,
    @Inject(LockService) private readonly locks: Pick<LockService, "acquire">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "info" | "warn">,
  ) {}

  /** Whether any org has a blob to hash (the kickoff's test). */
  anyUnhashed(): Promise<boolean> {
    return asPlatform("file library hashing: whether any blob is unhashed", async () => {
      // deployment-wide existence check of the hashing kickoff; deleted orgs are left to the purge
      const row = await this.db
        .selectFrom("blobs")
        .innerJoin("orgs", "orgs.id", "blobs.org_id")
        .select("blobs.id")
        .where("orgs.deleted_at", "is", null)
        .where("blobs.sha256", "is", null)
        .where("blobs.status", "=", "ready")
        .where("blobs.dedup_after", "<=", sql<Date>`now()`)
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    });
  }

  /** Owes the dispatcher (a no-op while it is owed or waiting: the same job id). */
  @Transactional()
  async oweDispatch(): Promise<boolean> {
    return this.outbox.add({
      queue: MAINTENANCE_QUEUE_NAME,
      name: FILE_LIBRARY_HASH_JOB,
      jobId: FILE_LIBRARY_HASH_JOB,
      data: null,
    });
  }

  /** The dispatcher job: owes the first batch of every live org with unhashed blobs. */
  async dispatch(): Promise<number> {
    if (!(await this.backfill.settled())) return 0;
    const orgs = await asPlatform(
      "file library hashing: the orgs with unhashed blobs",
      async () => {
        // deployment-wide: which orgs to hash (each org then hashes in its scope)
        const rows = await this.db
          .selectFrom("blobs")
          .innerJoin("orgs", "orgs.id", "blobs.org_id")
          .select("blobs.org_id")
          .distinct()
          .where("orgs.deleted_at", "is", null)
          .where("blobs.sha256", "is", null)
          .where("blobs.status", "=", "ready")
          .where("blobs.dedup_after", "<=", sql<Date>`now()`)
          .execute();
        return rows.map((r) => r.org_id);
      },
    );
    if (orgs.length > 0) await this.oweFirstBatches(orgs);
    return orgs.length;
  }

  @Transactional()
  private async oweFirstBatches(orgIds: readonly string[]): Promise<void> {
    await this.outbox.addMany(
      orgIds.map((orgId) => ({
        queue: MAINTENANCE_QUEUE_NAME,
        name: FILE_LIBRARY_HASH_ORG_JOB,
        jobId: fileLibraryHashOrgJobId(orgId, null),
        data: { orgId, after: null } satisfies HashOrgData,
        orgId,
      })),
    );
  }

  /** One org batch (see the class comment), in the org's scope. */
  runOrgBatch(data: HashOrgData): Promise<HashBatchResult> {
    return withOrgScope(data.orgId, () => this.orgBatch(data));
  }

  private async orgBatch(data: HashOrgData): Promise<HashBatchResult> {
    const result: HashBatchResult = { ran: false, outcomes: {}, next: null };
    const handle = await this.locks.acquire(orgLockKey(data.orgId), { ttlMs: ORG_LOCK_TTL_MS });
    // another chain hashes this org now; it owes its own next batches
    if (!handle) return result;
    try {
      if (!(await this.backfill.settled())) return result;
      result.ran = true;
      const rows = await this.unhashed(data);
      for (const row of rows) {
        // the lock is lost: stop here, the next pass starts again (merges are checked anyway)
        if (handle.lost.aborted) return result;
        let outcome: HashOutcome | "failed";
        try {
          outcome = await this.hashOne(data.orgId, row, handle.lost);
        } catch (err) {
          // transient (storage, a short read): a later pass tries it again
          this.log.warn("cannot hash a file library blob; will retry later", {
            orgId: data.orgId,
            blobId: row.id,
            err,
          });
          outcome = "failed";
        }
        result.outcomes[outcome] = (result.outcomes[outcome] ?? 0) + 1;
      }
      if (rows.length === HASH_BATCH) result.next = (rows.at(-1) as UnhashedBlob).id;
    } finally {
      await handle.release();
    }
    // owed after the lock is released, so the next batch can take it
    if (result.next !== null) await this.oweNext(data.orgId, result.next);
    return result;
  }

  /** Up to {@link HASH_BATCH} blobs to hash after the cursor. */
  private unhashed(data: HashOrgData): Promise<UnhashedBlob[]> {
    return this.db
      .selectFrom("blobs")
      .select(["id", "object_key", "size", "etag"])
      .where("org_id", "=", data.orgId)
      .where("sha256", "is", null)
      .where("status", "=", "ready")
      .where("dedup_after", "<=", sql<Date>`now()`)
      .$if(data.after !== null, (q) => q.where("id", ">", data.after as string))
      .orderBy("id")
      .limit(HASH_BATCH)
      .execute();
  }

  @Transactional()
  private async oweNext(orgId: string, after: string): Promise<void> {
    await this.outbox.add({
      queue: MAINTENANCE_QUEUE_NAME,
      name: FILE_LIBRARY_HASH_ORG_JOB,
      jobId: fileLibraryHashOrgJobId(orgId, after),
      data: { orgId, after } satisfies HashOrgData,
      orgId,
    });
  }

  /** Hashes one blob and settles the outcome (see the class comment). Throws on transient errors. */
  async hashOne(orgId: string, row: UnhashedBlob, stop?: AbortSignal): Promise<HashOutcome> {
    const recorded = { size: Number(row.size), etag: row.etag };
    // a lost org lock or a stuck store ends the read (the blob is tried again on a later pass)
    const timeout = AbortSignal.timeout(HASH_READ_TIMEOUT_MS);
    const signal = stop ? AbortSignal.any([stop, timeout]) : timeout;
    const got = await this.storage.kernel(orgId).get(row.object_key, { signal });
    if (!got) return this.markGone(orgId, row.id);
    if (!blobContentMatches(recorded, got.head)) {
      // replaced after it was recorded (a staging object written again): reads treat it as gone
      await got.body.cancel().catch(() => {});
      return this.markGone(orgId, row.id);
    }
    const hash = createHash("sha256");
    let read = 0;
    const reader = got.body.getReader();
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => {});
    try {
      for (;;) {
        // a read stalled in the store is interrupted by the abort, not only checked between chunks
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        hash.update(value);
        read += value.byteLength;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) await reader.cancel().catch(() => {});
      try {
        reader.releaseLock();
      } catch {
        // a read still pending after the cancel: the stream is dropped with the reader
      }
    }
    if (read !== recorded.size) {
      throw new Error(`read ${read} bytes of blob ${row.id}, expected ${recorded.size}`);
    }
    return this.settleHash(orgId, row.id, hash.digest("hex"));
  }

  /** The object is missing or replaced: the blob is `gone` (while still unhashed and `ready`). */
  @Transactional()
  private async markGone(orgId: string, blobId: string): Promise<HashOutcome> {
    const r = await this.db.db
      .updateTable("blobs")
      .set({ status: "gone" })
      .where("id", "=", blobId)
      .where("org_id", "=", orgId)
      .where("status", "=", "ready")
      .where("sha256", "is", null)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) > 0 ? "gone" : "skipped";
  }

  /** The transaction of {@link hashOne} once the hash is known (see the class comment). */
  @Transactional()
  private async settleHash(orgId: string, blobId: string, sha256: string): Promise<HashOutcome> {
    const trx = this.db.db;
    await this.hashLock.lock(orgId, sha256);
    // the rows a merge moves, locked file rows first and then the blob, the order every other
    // writer of a file and its blob takes (a release, a delete), so the two never deadlock
    await trx
      .selectFrom("files")
      .select("id")
      .where("org_id", "=", orgId)
      .where("blob_id", "=", blobId)
      .orderBy("id")
      .forUpdate()
      .execute();
    const own = await trx
      .selectFrom("blobs")
      .select(["id", "object_key", "etag", "size", "status", "sha256"])
      .where("id", "=", blobId)
      .where("org_id", "=", orgId)
      .forUpdate()
      .executeTakeFirst();
    if (own?.status !== "ready" || own.sha256 !== null) return "skipped";
    const holder = await trx
      .selectFrom("blobs")
      .select(["id", "status", sql<boolean>`dedup_after <= now()`.as("dedupable")])
      .where("org_id", "=", orgId)
      .where("sha256", "=", sha256)
      .executeTakeFirst();
    if (holder === undefined || holder.status !== "ready") {
      // a holder being deleted or gone gives the hash up (as `BlobsService.settle` does)
      if (holder !== undefined) {
        await trx
          .updateTable("blobs")
          .set({ sha256: null })
          .where("id", "=", holder.id)
          .where("org_id", "=", orgId)
          .where("status", "<>", "ready")
          .execute();
      }
      await trx
        .updateTable("blobs")
        .set({ sha256 })
        .where("id", "=", blobId)
        .where("org_id", "=", orgId)
        .execute();
      return "hashed";
    }
    if (!holder.dedupable) return "skipped";
    const winner = await this.blobs.lockReady(orgId, holder.id);
    if (winner === null) return "skipped";
    if (winner.size !== Number(own.size)) {
      this.log.warn("two blobs with one sha256 differ in size; not merging", {
        orgId,
        blobId,
        holderId: winner.id,
      });
      return "skipped";
    }
    // files keep the reference the model saw: the key and etag of the blob they were stored on
    await trx
      .updateTable("files")
      .set({
        blob_id: winner.id,
        ref_key: sql<string>`coalesce(ref_key, ${own.object_key})`,
        ref_etag: sql<
          string | null
        >`CASE WHEN ref_key IS NULL THEN ${own.etag}::text ELSE ref_etag END`,
      })
      .where("org_id", "=", orgId)
      .where("blob_id", "=", blobId)
      .execute();
    await trx
      .updateTable("file_shares")
      .set({ blob_id: winner.id })
      .where("org_id", "=", orgId)
      .where("blob_id", "=", blobId)
      .execute();
    await trx
      .updateTable("blobs")
      .set({ status: "deleting" })
      .where("id", "=", blobId)
      .where("org_id", "=", orgId)
      .execute();
    await oweBlobDelete(this.outbox, orgId, blobId, new Date(Date.now() + MERGE_DELETE_DELAY_MS));
    return "merged";
  }
}

/**
 * The hourly kickoff of the file library's background work (`@LockedInterval`, once per tick
 * across replicas, also once at worker start; provided only under `WorkerModule`): until the
 * catch-up copy settled it owes {@link FileLibraryBackfill} (30 minutes later while the deploy is
 * recent); afterwards, while unhashed blobs exist, it owes the hashing dispatcher. Both are owed
 * under deterministic ids, so owing them again while they wait is a no-op.
 */
@Injectable()
export class FileLibraryKickoffJob {
  constructor(
    @Inject(FileLibraryBackfill)
    private readonly backfill: Pick<FileLibraryBackfill, "settled" | "ensureOwed">,
    @Inject(FileLibraryHashJob)
    private readonly hashing: Pick<FileLibraryHashJob, "anyUnhashed" | "oweDispatch">,
    @Inject(KernelConfigService) readonly config: KernelConfigService,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedInterval(FILE_LIBRARY_KICKOFF_JOB, () => FILE_LIBRARY_KICKOFF_PERIOD_MS, {
    runOnStart: true,
  })
  async tick(): Promise<void> {
    const r = await this.runOnce();
    if (r.backfillOwed || r.hashOwed) this.log.info("file library jobs owed", { ...r });
  }

  /** One kickoff without the tick lock (the interval body; tests call it directly). */
  async runOnce(): Promise<{ backfillOwed: boolean; hashOwed: boolean }> {
    if (!(await this.backfill.settled())) {
      return { backfillOwed: await this.backfill.ensureOwed(), hashOwed: false };
    }
    if (!(await this.hashing.anyUnhashed())) return { backfillOwed: false, hashOwed: false };
    return { backfillOwed: false, hashOwed: await this.hashing.oweDispatch() };
  }
}
