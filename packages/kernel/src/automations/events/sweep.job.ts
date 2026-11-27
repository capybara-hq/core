import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { asPlatform, withOrgScope } from "../../infra/database/org-scope.js";
import { TransactionHost } from "../../infra/database/transaction-host.js";
import { Transactional } from "../../infra/database/transactional.decorator.js";
import { LockService } from "../../infra/lock/lock.service.js";
import { OutboxService } from "../../infra/outbox/outbox.service.js";
import { LockedCron } from "../../infra/schedule/locked-cron.decorator.js";
import { KERNEL_LOGGER } from "../../infra/tokens.js";
import type { KernelLogger } from "../../log.js";
import { MAINTENANCE_QUEUE_NAME } from "../../runtime/maintenance-queue.js";
import { readAutomationSettings } from "../effective-settings.js";
import {
  AUTOMATION_COALESCE_JOB,
  type AutomationCoalesceJobData,
  TRIGGER_EVENT_SWEEP_JOB,
} from "../job-ids.js";
import { COALESCE_STALE_MS, coalesceJobIdOfKey } from "./guards.js";

const DAY_MS = 86_400_000;
/** Events deleted per transaction. */
const DELETE_BATCH = 500;
/** Batches per sweep; what is left waits for the next one. */
const MAX_BATCHES = 40;
/** Waiting windows looked at per sweep. */
const MAX_WINDOWS = 1000;

/** A window of an (automation, subject) pair whose deliveries still wait for a run. */
interface WaitingWindow {
  orgId: string;
  automationId: string;
  subjectKey: string;
  /** The event of the window's first waiting delivery (its job id names it). */
  firstEventId: string;
  first: Date;
}

/**
 * The trigger event sweep (collaboration spec §4.7), every five minutes across replicas:
 *
 * - **Retention.** A trigger event settled (`dispatched`, `undelivered`, `depth_stopped`) more than
 *   `automations.eventRetentionDays` ago, none of whose deliveries still waits for a run, is
 *   deleted with its deliveries (the foreign key cascades), in batches of {@link DELETE_BATCH}, one
 *   transaction each. A `pending` event (a directed one waiting for acceptance routing) stays. A
 *   run keeps its `trigger_key` and a kernel run its `trigger_event_id` (neither has a foreign
 *   key); a chain whose event is gone restarts at depth 0.
 * - **Lost windows.** The dispatcher owes one coalesce job per window, from the delivery that opens
 *   it. A window whose first delivery has waited longer than the org's `coalesceSeconds` plus
 *   {@link COALESCE_STALE_MS} lost its job for good (dead in the outbox, or failed in the queue);
 *   unless an outbox row for it is still pending, the sweep owes a coalesce job of its own
 *   (`<window job id>-sweep-<minute>`, due now). The flush is idempotent, so a duplicate finds
 *   nothing waiting.
 */
@Injectable()
// org-filter: deployment-wide sweeps of trigger events and waiting deliveries (LockedCron), each
// owed job in its own org
export class TriggerEventSweepJob {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedCron("*/5 * * * *", { name: TRIGGER_EVENT_SWEEP_JOB })
  async sweep(): Promise<void> {
    await this.sweepAt(new Date());
  }

  /** One sweep as of `now` (tests pass their own): how many events it deleted and windows it owed. */
  async sweepAt(now: Date): Promise<{ deleted: number; owed: number }> {
    const days = this.config.get().automations.eventRetentionDays;
    const cutoff = new Date(now.getTime() - days * DAY_MS);
    let deleted = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const n = await this.deleteBatch(cutoff);
      deleted += n;
      if (n < DELETE_BATCH) break;
    }
    if (deleted > 0) this.log.info("old trigger events deleted", { deleted, retentionDays: days });
    let owed = 0;
    for (const w of await this.waitingWindows(now)) {
      if (await withOrgScope(w.orgId, () => this.oweFlush(w, now))) owed++;
    }
    return { deleted, owed };
  }

  /** Deletes one batch of settled events older than `cutoff` (see the class); returns how many. */
  @Transactional()
  private async deleteBatch(cutoff: Date): Promise<number> {
    const db = this.kdb.db;
    return asPlatform("deployment-wide trigger event retention sweep", async () => {
      const r = await sql<{ id: string }>`
        DELETE FROM capybara.trigger_events
        WHERE id IN (
          SELECT e.id FROM capybara.trigger_events e
          WHERE e.state IN ('dispatched', 'undelivered', 'depth_stopped')
            AND e.created_at < ${cutoff}
            AND NOT EXISTS (
              SELECT 1 FROM capybara.automation_event_deliveries d
              WHERE d.event_id = e.id AND d.automation_run_id IS NULL
            )
          ORDER BY e.created_at
          LIMIT ${DELETE_BATCH}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id`.execute(db);
      return r.rows.length;
    });
  }

  /**
   * The windows whose first waiting delivery is older than their org's `coalesceSeconds` plus
   * {@link COALESCE_STALE_MS} (see the class), oldest first.
   */
  private async waitingWindows(now: Date): Promise<WaitingWindow[]> {
    const db = this.kdb.db;
    // coalesceSeconds is at least 1: anything younger than the stale margin is not stale anywhere
    const older = new Date(now.getTime() - COALESCE_STALE_MS);
    const rows = await asPlatform("deployment-wide lost coalescing window sweep", () =>
      sql<{
        org_id: string;
        automation_id: string;
        subject_key: string;
        first_event_id: string;
        first: Date;
      }>`
        SELECT DISTINCT ON (d.automation_id, d.subject_key)
          d.org_id, d.automation_id, d.subject_key, d.event_id AS first_event_id,
          d.created_at AS first
        FROM capybara.automation_event_deliveries d
        JOIN capybara.trigger_events e ON e.id = d.event_id
        WHERE d.automation_run_id IS NULL
          AND d.created_at < ${older}
        ORDER BY d.automation_id, d.subject_key, d.created_at, e.created_at, e.id
        LIMIT ${MAX_WINDOWS}`.execute(db),
    );
    const settings = new Map<string, number>();
    const out: WaitingWindow[] = [];
    for (const r of rows.rows) {
      let coalesceSeconds = settings.get(r.org_id);
      if (coalesceSeconds === undefined) {
        coalesceSeconds = (
          await withOrgScope(r.org_id, () => readAutomationSettings(db, this.config, r.org_id))
        ).coalesceSeconds;
        settings.set(r.org_id, coalesceSeconds);
      }
      const first = new Date(r.first);
      if (now.getTime() - first.getTime() <= coalesceSeconds * 1000 + COALESCE_STALE_MS) continue;
      out.push({
        orgId: r.org_id,
        automationId: r.automation_id,
        subjectKey: r.subject_key,
        firstEventId: r.first_event_id,
        first,
      });
    }
    return out.sort((a, b) => a.first.getTime() - b.first.getTime());
  }

  /**
   * Owes the window's coalesce job unless an outbox row for it (the dispatcher's or an earlier
   * sweep's) is still pending; true when it owed one.
   */
  @Transactional()
  private async oweFlush(w: WaitingWindow, now: Date): Promise<boolean> {
    const db = this.kdb.db;
    const base = `${coalesceJobIdOfKey(w.automationId, w.subjectKey)}-${w.firstEventId}`;
    const pending = await db
      .selectFrom("outbox")
      .select("id")
      .where("org_id", "=", w.orgId)
      .where("queue", "=", MAINTENANCE_QUEUE_NAME)
      .where("job_name", "=", AUTOMATION_COALESCE_JOB)
      .where((eb) =>
        eb.or([eb("job_id", "=", base), sql<boolean>`starts_with(job_id, ${`${base}-sweep-`})`]),
      )
      .where("dead_at", "is", null)
      .limit(1)
      .executeTakeFirst();
    if (pending !== undefined) return false;
    this.log.warn("coalescing window lost its job; the sweep owes one", {
      orgId: w.orgId,
      automationId: w.automationId,
      subjectKey: w.subjectKey,
      waitingSince: w.first.toISOString(),
    });
    return this.outbox.add<AutomationCoalesceJobData>({
      queue: MAINTENANCE_QUEUE_NAME,
      name: AUTOMATION_COALESCE_JOB,
      jobId: `${base}-sweep-${Math.floor(now.getTime() / 60_000)}`,
      data: { orgId: w.orgId, automationId: w.automationId, subjectKey: w.subjectKey },
      orgId: w.orgId,
    });
  }
}
