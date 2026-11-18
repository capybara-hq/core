import { Inject, Injectable } from "@nestjs/common";
import { type ExpressionBuilder, sql } from "kysely";
import type { KernelDatabase } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { StorageService } from "../storage/storage.service.js";
import { creatorStillHasAccess } from "./liveness.js";
import { revokeSharesIn } from "./revoke.js";
import {
  type ShareObjectDeleteData,
  ShareObjects,
  shareObjectKey,
  shareRefreshLockKey,
} from "./share-objects.js";

/** The daily share sweep's name (scheduler key and lock; no `:`). */
export const SHARE_SWEEP_JOB = "share-sweep";

/** Rows per batch (one transaction per batch of revokes; one query per batch of reads). */
const BATCH = 200;
/** Snapshots of shares expired or revoked longer ago than this are deleted (rows kept). */
const RETAIN_DAYS = 7;
/** An object under `shares/` no row names is deleted only once it is older than this. */
const ORPHAN_AGE_MS = 60 * 60 * 1000;
/** The objects listed per page when looking for orphans. */
const LIST_PAGE = 1000;
/** The sweep's hold on a share's refresh lock (tried once; a refresh holding it skips the key). */
const REFRESH_LOCK_TTL_MS = 30_000;
/**
 * `shares/<shareId>/<generation>`, the only key shape the shares module writes. Only the shares
 * module writes under `shares/`, so a key of any other shape is no snapshot and is deleted directly.
 */
const SHARE_KEY_RE =
  /^shares\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(\d+)$/;

/** What one sweep did (logged; returned for tests). */
export interface ShareSweepResult {
  /** Shares revoked with `creator_lost_access` (their snapshots owed for deletion). */
  revoked: number;
  /** Snapshots of shares expired or revoked more than {@link RETAIN_DAYS} days ago deleted. */
  freed: number;
  /** Orphan objects under `shares/` deleted. */
  orphans: number;
}

/**
 * The daily share sweep (file sharing spec §9), a `@LockedCron` (once per tick across replicas,
 * provided only under `WorkerModule`). In order, with every storage call outside a transaction:
 *
 * 1. revokes with `creator_lost_access` the unrevoked, unexpired shares whose creator fails the
 *    live check's creator predicates (account disabled, no longer a member, agent deleted or hidden,
 *    the conversation or its root deleted), one transaction per batch, owing each snapshot's
 *    deletion through the outbox (the open routes already refuse them; this frees the snapshot and
 *    shows a reason in the lists);
 * 2. deletes the snapshots of shares expired or revoked more than {@link RETAIN_DAYS} days ago that
 *    still name one (a revoke owes its deletion at once; this is the expired shares' path and the
 *    backstop) and clears `object_key`; the rows stay for the audit trail;
 * 3. per organization not deleted, lists `shares/` and deletes every object older than one hour
 *    that is not the `object_key` of its row (no row: an insert that failed after its copy; another
 *    generation: a refresh that died between its copy and its commit). An object whose age the
 *    store does not report is kept. Its age is read again (`head`) just before the delete, and a
 *    non-current generation of an existing share is deleted only under that share's refresh lock
 *    (tried once), so a retried refresh writing the same key again is never undone.
 *
 * Steps 2 and 3 go through {@link ShareObjects.deleteObject}, which re-reads the row and never
 * deletes the snapshot a share that is neither revoked nor expired currently names. Deleted
 * organizations are skipped: their objects go with `storage-org-purge`. Nothing is kept in process
 * memory between runs; a run that stops midway (abort, error) is finished by the next one.
 */
@Injectable()
export class ShareSweepJob {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    @Inject(ShareObjects) private readonly objects: Pick<ShareObjects, "deleteObject">,
    @Inject(StorageService) private readonly storage: Pick<StorageService, "available" | "kernel">,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedCron("40 3 * * *", { name: SHARE_SWEEP_JOB })
  async sweep(signal?: AbortSignal): Promise<void> {
    const r = await this.runOnce(signal);
    if (r.revoked + r.freed + r.orphans > 0) this.log.info("share sweep done", { ...r });
  }

  /** One sweep without the tick lock (the cron body; tests call it directly). */
  async runOnce(signal?: AbortSignal): Promise<ShareSweepResult> {
    const revoked = await this.revokeLostAccess(signal);
    if (!this.storage.available) return { revoked, freed: 0, orphans: 0 };
    const freed = await this.freeOld(signal);
    const orphans = await this.deleteOrphans(signal);
    return { revoked, freed, orphans };
  }

  /** Step 1: revokes, batch by batch, the shares whose creator lost access. */
  private async revokeLostAccess(signal?: AbortSignal): Promise<number> {
    let revoked = 0;
    let after: string | null = null;
    while (!signal?.aborted) {
      const rows = await this.db
        .selectFrom("file_shares")
        .innerJoin("orgs", "orgs.id", "file_shares.org_id")
        .select("file_shares.id")
        .where("orgs.deleted_at", "is", null)
        .where("file_shares.revoked_at", "is", null)
        .where("file_shares.object_key", "is not", null)
        .where((eb) =>
          eb.or([
            eb("file_shares.expires_at", "is", null),
            eb("file_shares.expires_at", ">", sql<Date>`now()`),
          ]),
        )
        .where((eb) =>
          eb.not(
            creatorStillHasAccess(
              eb as unknown as ExpressionBuilder<KernelDatabase, "file_shares">,
            ),
          ),
        )
        .$if(after !== null, (q) => q.where("file_shares.id", ">", after as string))
        .orderBy("file_shares.id")
        .limit(BATCH)
        .execute();
      if (rows.length === 0) break;
      revoked += await this.revokeBatch(rows.map((r) => r.id));
      after = (rows.at(-1) as { id: string }).id;
      if (rows.length < BATCH) break;
    }
    return revoked;
  }

  /** One batch of step 1 (the creator's access is checked again in the `UPDATE`). */
  @Transactional()
  async revokeBatch(shareIds: readonly string[]): Promise<number> {
    return revokeSharesIn(this.db.db, this.outbox, { shareIds }, "creator_lost_access");
  }

  /** Step 2: frees the snapshots of shares expired or revoked more than a week ago. */
  private async freeOld(signal?: AbortSignal): Promise<number> {
    let freed = 0;
    let after: string | null = null;
    while (!signal?.aborted) {
      const old = sql<Date>`now() - make_interval(days => ${RETAIN_DAYS})`;
      const rows = await this.db
        .selectFrom("file_shares")
        .innerJoin("orgs", "orgs.id", "file_shares.org_id")
        .select([
          "file_shares.id",
          "file_shares.org_id",
          "file_shares.generation",
          "file_shares.object_key",
        ])
        .where("orgs.deleted_at", "is", null)
        .where("file_shares.object_key", "is not", null)
        .where((eb) =>
          eb.or([
            eb("file_shares.revoked_at", "<", old),
            eb.and([
              eb("file_shares.revoked_at", "is", null),
              eb("file_shares.expires_at", "<", old),
            ]),
          ]),
        )
        .$if(after !== null, (q) => q.where("file_shares.id", ">", after as string))
        .orderBy("file_shares.id")
        .limit(BATCH)
        .execute();
      if (rows.length === 0) break;
      for (const r of rows) {
        if (signal?.aborted) break;
        const data: ShareObjectDeleteData = {
          orgId: r.org_id,
          shareId: r.id,
          generation: r.generation,
          objectKey: r.object_key as string,
        };
        if (await this.deleteGuarded(data)) freed++;
      }
      after = (rows.at(-1) as { id: string }).id;
      if (rows.length < BATCH) break;
    }
    return freed;
  }

  /** Step 3: deletes the orphan objects under `shares/` of every organization not deleted. */
  private async deleteOrphans(signal?: AbortSignal): Promise<number> {
    let deleted = 0;
    let after: string | null = null;
    while (!signal?.aborted) {
      const orgs = await this.db
        .selectFrom("orgs")
        .select("id")
        .where("deleted_at", "is", null)
        .$if(after !== null, (q) => q.where("id", ">", after as string))
        .orderBy("id")
        .limit(BATCH)
        .execute();
      for (const o of orgs) {
        if (signal?.aborted) break;
        try {
          deleted += await this.orphansOf(o.id, signal);
        } catch (err) {
          this.log.warn("share sweep: cannot clean orphan snapshots; the next run retries", {
            orgId: o.id,
            err,
          });
        }
      }
      if (orgs.length < BATCH) break;
      after = (orgs.at(-1) as { id: string }).id;
    }
    return deleted;
  }

  /** The orphan objects of one organization, page by page. */
  private async orphansOf(orgId: string, signal?: AbortSignal): Promise<number> {
    const store = this.storage.kernel(orgId);
    let deleted = 0;
    let cursor: string | undefined;
    do {
      const page = await store.list("shares/", {
        limit: LIST_PAGE,
        ...(cursor !== undefined && { cursor }),
      });
      cursor = page.cursor;
      // the rows are read once per page; `deleteObject` reads its row again before deleting
      const cutoff = Date.now() - ORPHAN_AGE_MS;
      const old = page.items.filter((i) => {
        const at = i.lastModified === undefined ? Number.NaN : Date.parse(i.lastModified);
        return Number.isFinite(at) && at < cutoff;
      });
      const parsed = old.map((i) => ({ key: i.key, m: SHARE_KEY_RE.exec(i.key) }));
      const ids = [...new Set(parsed.flatMap((p) => (p.m ? [p.m[1] as string] : [])))];
      const named = new Map<string, string | null>();
      if (ids.length > 0) {
        const rows = await this.db
          .selectFrom("file_shares")
          .select(["id", "object_key"])
          .where("org_id", "=", orgId)
          .where("id", "in", ids)
          .execute();
        for (const r of rows) named.set(r.id, r.object_key);
      }
      for (const p of parsed) {
        if (signal?.aborted) return deleted;
        const shareId = p.m?.[1];
        const generation = Number(p.m?.[2]);
        const snapshot =
          shareId !== undefined &&
          Number.isSafeInteger(generation) &&
          shareObjectKey(shareId, generation) === p.key;
        if (!snapshot || shareId === undefined) {
          if (await this.stillOld(store, p.key, cutoff)) {
            await store.delete(p.key);
            deleted++;
          }
          continue;
        }
        if (named.get(shareId) === p.key) continue; // its row's snapshot: step 2's, not an orphan
        const data: ShareObjectDeleteData = { orgId, shareId, generation, objectKey: p.key };
        if (!named.has(shareId)) {
          // no row (an insert that failed after its copy): a new create uses a new id
          if ((await this.stillOld(store, p.key, cutoff)) && (await this.deleteGuarded(data))) {
            deleted++;
          }
          continue;
        }
        // another generation of an existing share: a retried refresh may be writing this very key
        // again, its commit about to name it. Held, the refresh lock means no refresh is between its
        // copy and its commit, so the row `deleteObject` reads is the last word; a refresh holding
        // it now skips the key (the next run sees it again)
        const lock = await this.lockService.acquire(shareRefreshLockKey(shareId), {
          ttlMs: REFRESH_LOCK_TTL_MS,
          waitMs: 0,
        });
        if (!lock) continue;
        try {
          if ((await this.stillOld(store, p.key, cutoff)) && (await this.deleteGuarded(data))) {
            deleted++;
          }
        } finally {
          await lock.release();
        }
      }
    } while (cursor !== undefined && !signal?.aborted);
    return deleted;
  }

  /**
   * Whether `key` is still older than `cutoff` now: the listing may be stale (an upload that started
   * long ago, or a key written again since), so its age is read again just before deleting it.
   */
  private async stillOld(
    store: ReturnType<StorageService["kernel"]>,
    key: string,
    cutoff: number,
  ): Promise<boolean> {
    const head = await store.head(key);
    if (!head?.lastModified) return false;
    const at = Date.parse(head.lastModified);
    return Number.isFinite(at) && at < cutoff;
  }

  /** {@link ShareObjects.deleteObject}, logging instead of throwing (one bad object stops nothing). */
  private async deleteGuarded(data: ShareObjectDeleteData): Promise<boolean> {
    try {
      await this.objects.deleteObject(data);
      return true;
    } catch (err) {
      this.log.warn("share sweep: cannot delete a share snapshot; the next run retries", {
        orgId: data.orgId,
        shareId: data.shareId,
        generation: data.generation,
        err,
      });
      return false;
    }
  }
}
