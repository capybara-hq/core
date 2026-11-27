import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";
import { asPlatform } from "../infra/database/org-scope.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";

/** The one-off catch-up copy's job name and deterministic id (no `:`). */
export const FILE_LIBRARY_BACKFILL_JOB = "file-library-backfill";

/**
 * The `deployment_settings` key that records the catch-up copy settled (it ran, or it was skipped
 * because the deploy is too long ago). Not a setting a person edits: the settings reader ignores
 * keys it does not know.
 */
export const FILE_LIBRARY_COPY_SETTLED = "fileLibraryCopySettled";

/** The migration that created the file library and its copy function. */
export const FILE_LIBRARY_MIGRATION = "0189_file_library.sql";

/** How long after it is owed the catch-up runs: once the rolling window of the deploy is over. */
export const BACKFILL_DELAY_MS = 30 * 60_000;

/** After this many days since the migration the catch-up is skipped (nothing old is left). */
export const BACKFILL_WINDOW_DAYS = 7;

/** How far before the migration the catch-up copies from (rows written around the deploy). */
const BACKFILL_LOOKBACK = "1 hour";

/** The value stored under {@link FILE_LIBRARY_COPY_SETTLED}. */
interface CopySettled {
  outcome: "copied" | "skipped";
  at: string;
}

/**
 * The one-off catch-up of the file library's data copy (plan amendment K9). During a rolling deploy
 * old replicas keep writing chat attachments, artifacts and shares the old way after migration
 * 0190 copied them; once the window is over this job runs `file_library_copy(<0189 applied_at - 1
 * hour>)` (idempotent) so those rows become library files, blobs and references too. It runs once
 * (deterministic job id `file-library-backfill`, the settled marker in the copy's own transaction)
 * and is skipped more than {@link BACKFILL_WINDOW_DAYS} days after the migration.
 *
 * The hashing job merges no blob before the marker exists ({@link settled}): the copy re-points a
 * share whose blob differs from the blob of its legacy `object_key`, so a share merged before the
 * copy would be pointed back at the merged duplicate.
 */
@Injectable()
export class FileLibraryBackfill {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "info">,
  ) {}

  /** Whether the catch-up copy settled (ran or was skipped): the hashing job may merge blobs. */
  async settled(): Promise<boolean> {
    const row = await this.db
      .selectFrom("deployment_settings")
      .select("key")
      .where("key", "=", FILE_LIBRARY_COPY_SETTLED)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Owes the catch-up unless it settled: {@link BACKFILL_DELAY_MS} from now while the migration is
   * within the window (the worker start of a deploy), at once otherwise (it only records the skip).
   * Owing it again while it is waiting is a no-op (the same job id). Returns whether a row was
   * written.
   */
  async ensureOwed(): Promise<boolean> {
    if (await this.settled()) return false;
    const applied = await this.appliedAt();
    if (applied === undefined) return false;
    const runAt = this.withinWindow(applied) ? new Date(Date.now() + BACKFILL_DELAY_MS) : undefined;
    return this.owe(runAt);
  }

  @Transactional()
  private async owe(runAt: Date | undefined): Promise<boolean> {
    return this.outbox.add({
      queue: MAINTENANCE_QUEUE_NAME,
      name: FILE_LIBRARY_BACKFILL_JOB,
      jobId: FILE_LIBRARY_BACKFILL_JOB,
      data: null,
      ...(runAt !== undefined && { runAt }),
    });
  }

  /**
   * The job (deployment-wide): the copy from an hour before the migration, or the skip when the
   * migration is older than the window; either way the settled marker, in the same transaction.
   * Nothing to do once settled.
   */
  run(): Promise<CopySettled["outcome"] | "settled"> {
    return asPlatform("file library catch-up copy across every org", () => this.copyOnce());
  }

  @Transactional()
  private async copyOnce(): Promise<CopySettled["outcome"] | "settled"> {
    if (await this.settled()) return "settled";
    const applied = await this.appliedAt();
    if (applied === undefined) throw new Error(`${FILE_LIBRARY_MIGRATION} is not applied`);
    let outcome: CopySettled["outcome"] = "skipped";
    if (this.withinWindow(applied)) {
      // the function names the tables itself, each statement deployment-wide by design
      await sql`SELECT capybara.file_library_copy(${applied}::timestamptz - ${BACKFILL_LOOKBACK}::interval)`.execute(
        this.db.db,
      );
      outcome = "copied";
    }
    const value: CopySettled = { outcome, at: new Date().toISOString() };
    await this.db.db
      .insertInto("deployment_settings")
      .values({ key: FILE_LIBRARY_COPY_SETTLED, value: JSON.stringify(value) })
      .onConflict((oc) => oc.column("key").doNothing())
      .execute();
    this.log.info("file library catch-up copy settled", { outcome });
    return outcome;
  }

  /** When the migration was applied (the migrator's own bookkeeping), undefined when it was not. */
  private async appliedAt(): Promise<Date | undefined> {
    const r = await sql<{ applied_at: Date }>`SELECT applied_at FROM capybara._migrations
      WHERE name = ${FILE_LIBRARY_MIGRATION}`.execute(this.db.db);
    return r.rows[0]?.applied_at;
  }

  private withinWindow(applied: Date): boolean {
    return Date.now() - applied.getTime() <= BACKFILL_WINDOW_DAYS * 24 * 3_600_000;
  }
}
