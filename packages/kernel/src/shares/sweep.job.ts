import { Inject, Injectable } from "@nestjs/common";
import { type ExpressionBuilder, sql } from "kysely";
import type { KernelDatabase } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { withOrgScope } from "../infra/database/org-scope.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { creatorStillHasAccess } from "./liveness.js";
import { revokeSharesIn } from "./revoke.js";

/** The daily share sweep's name (scheduler key and lock; no `:`). */
export const SHARE_SWEEP_JOB = "share-sweep";

/** When the daily share sweep runs (the deployment's time zone). */
export const SHARE_SWEEP_CRON = "40 3 * * *";

/** Rows per batch (one transaction per batch). */
const BATCH = 200;
/** Shares expired or revoked longer ago than this stop pointing at their blob (rows kept). */
export const RETAIN_DAYS = 7;

/** What one sweep did (logged; returned for tests). */
export interface ShareSweepResult {
  /** Shares revoked with `creator_lost_access`. */
  revoked: number;
  /** Shares expired or revoked more than {@link RETAIN_DAYS} days ago that let go of their blob. */
  freed: number;
}

/**
 * The daily share sweep (file sharing spec §9, file library spec §7), a `@LockedCron` (once per
 * tick across replicas, provided only under `WorkerModule`). In order:
 *
 * 1. revokes with `creator_lost_access` the unrevoked, unexpired shares whose creator fails the
 *    live check's creator predicates (account disabled, no longer a member, agent deleted or hidden,
 *    the conversation or its root deleted), one transaction per batch (the open routes already
 *    refuse them; this shows a reason in the lists);
 * 2. frees the shares expired or revoked more than {@link RETAIN_DAYS} days ago: `blob_id` becomes
 *    null (the rows stay for the audit trail), so the blob sweep may delete a blob no file or other
 *    share still needs. No storage call: the bytes are the blob's.
 *
 * Deleted organizations are skipped: their objects go with `storage-org-purge`. Nothing is kept in
 * process memory between runs; a run that stops midway (abort, error) is finished by the next one.
 */
@Injectable()
export class ShareSweepJob {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedCron(SHARE_SWEEP_CRON, { name: SHARE_SWEEP_JOB })
  async sweep(signal?: AbortSignal): Promise<void> {
    const r = await this.runOnce(signal);
    if (r.revoked + r.freed > 0) this.log.info("share sweep done", { ...r });
  }

  /** One sweep without the tick lock (the cron body; tests call it directly). */
  async runOnce(signal?: AbortSignal): Promise<ShareSweepResult> {
    const revoked = await this.revokeLostAccess(signal);
    const freed = await this.freeOld(signal);
    return { revoked, freed };
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
    return revokeSharesIn(this.db.db, { shareIds }, "creator_lost_access");
  }

  /** Step 2: lets go of the blobs of shares expired or revoked more than a week ago. */
  private async freeOld(signal?: AbortSignal): Promise<number> {
    let freed = 0;
    let after: string | null = null;
    while (!signal?.aborted) {
      const old = sql<Date>`now() - make_interval(days => ${RETAIN_DAYS})`;
      const rows = await this.db
        .selectFrom("file_shares")
        .innerJoin("orgs", "orgs.id", "file_shares.org_id")
        .select(["file_shares.id", "file_shares.org_id"])
        .where("orgs.deleted_at", "is", null)
        .where("file_shares.blob_id", "is not", null)
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
      const byOrg = new Map<string, string[]>();
      for (const r of rows) byOrg.set(r.org_id, [...(byOrg.get(r.org_id) ?? []), r.id]);
      for (const [orgId, ids] of byOrg) {
        freed += await withOrgScope(orgId, () => this.freeBatch(orgId, ids));
      }
      after = (rows.at(-1) as { id: string }).id;
      if (rows.length < BATCH) break;
    }
    return freed;
  }

  /**
   * One batch of step 2 (one org, in its scope): the condition is checked again in the `UPDATE` (expiry is final and a
   * revoke is never undone, so a row read as old is still old).
   */
  @Transactional()
  async freeBatch(orgId: string, shareIds: readonly string[]): Promise<number> {
    const old = sql<Date>`now() - make_interval(days => ${RETAIN_DAYS})`;
    const rows = await this.db
      .updateTable("file_shares")
      .set({ blob_id: null })
      .where("org_id", "=", orgId)
      .where("id", "in", [...shareIds])
      .where("blob_id", "is not", null)
      .where((eb) =>
        eb.or([
          eb("revoked_at", "<", old),
          eb.and([eb("revoked_at", "is", null), eb("expires_at", "<", old)]),
        ]),
      )
      .returning("id")
      .execute();
    return rows.length;
  }
}
