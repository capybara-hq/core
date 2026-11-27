import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";
import { asPlatform, withOrgScope } from "../infra/database/org-scope.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { LibraryFilesService } from "./library-files.service.js";

/** The hourly cleanup's name (scheduler key and lock; no `:`). */
export const FILE_DRAFT_CLEANUP_JOB = "file-draft-cleanup";

/** Orgs one lookup of the cleanup takes. */
const ORG_BATCH = 500;

/**
 * The hourly cleanup of expired uploads and composer drafts (file library spec §3), a
 * `@LockedCron` (once per tick across replicas, provided only under `WorkerModule`): finds the
 * orgs with `uploading` / `draft` files past `expires_at`, then in each org's scope expires them
 * batch by batch ({@link LibraryFilesService.expireBatch}: `deleted`, the staging object or the
 * upload's own blob released through the outbox). Nothing is kept in process memory between
 * runs; a run that stops midway is finished by the next one.
 */
@Injectable()
export class FileDraftCleanupJob {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(LibraryFilesService)
    private readonly files: Pick<LibraryFilesService, "expireBatch">,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedCron("0 * * * *", { name: FILE_DRAFT_CLEANUP_JOB })
  async run(signal?: AbortSignal): Promise<void> {
    const n = await this.runOnce(signal);
    if (n > 0) this.log.info("expired uploads and drafts deleted", { count: n });
  }

  /** One cleanup without the tick lock (the cron body; tests call it directly). */
  async runOnce(signal?: AbortSignal): Promise<number> {
    let expired = 0;
    for (const orgId of await this.orgsWithExpired()) {
      for (;;) {
        if (signal?.aborted) return expired;
        const n = await withOrgScope(orgId, () => this.files.expireBatch(orgId));
        expired += n;
        if (n === 0) break;
      }
    }
    return expired;
  }

  /** The orgs that have expired uploads or drafts. */
  // org-filter: deployment-wide lookup of which orgs to clean; each org is then expired in its scope
  private orgsWithExpired(): Promise<string[]> {
    return asPlatform("deployment-wide lookup of orgs with expired uploads", async () => {
      const rows = await this.db
        .selectFrom("files")
        .select("org_id")
        .distinct()
        .where("status", "in", ["uploading", "draft"])
        .where("expires_at", "<", sql<Date>`now()`)
        .limit(ORG_BATCH)
        .execute();
      return rows.map((r) => r.org_id);
    });
  }
}
