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
const HOUR_MS = 3_600_000;
/** The sweep's period (its cron). */
const SWEEP_EVERY_MS = 5 * 60_000;
/**
 * A lost pair whose newest waiting delivery is older than this is no longer owed a job (the sweep
 * logs it once and stops).
 */
export const WINDOW_GIVE_UP_MS = DAY_MS;
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
  /** The pair's newest waiting delivery: the start of its newest window at the latest. */
  last: Date;
}

/**
 * What the sweep does at `nowMs` for a lost pair whose newest waiting delivery is `ageMs` old:
 * `owe` its job (every sweep for the first hour, then at sweeps on boundaries of a period that
 * doubles with each doubling of the age: 10 minutes from 1 hour, 20 from 2, ..., 160 from 16),
 * `wait`, or, past {@link WINDOW_GIVE_UP_MS}, `give_up` (`log` at the first sweep past it).
 */
export function reoweDecision(
  ageMs: number,
  nowMs: number,
): "owe" | "wait" | { give_up: { log: boolean } } {
  if (ageMs > WINDOW_GIVE_UP_MS)
    return { give_up: { log: ageMs - SWEEP_EVERY_MS <= WINDOW_GIVE_UP_MS } };
  if (ageMs < HOUR_MS) return "owe";
  const period = SWEEP_EVERY_MS * 2 ** (Math.floor(Math.log2(ageMs / HOUR_MS)) + 1);
  return Math.floor(nowMs / period) !== Math.floor((nowMs - SWEEP_EVERY_MS) / period)
    ? "owe"
    : "wait";
}

/**
 * The trigger event sweep (collaboration spec §4.7), every five minutes across replicas:
 *
 * - **Retention.** A trigger event settled (`dispatched`, `undelivered`, `depth_stopped`) more than
 *   `automations.eventRetentionDays` ago, none of whose deliveries still waits for a run, is
 *   deleted with its deliveries (the foreign key cascades), in batches of {@link DELETE_BATCH}, one
 *   transaction each. A `pending` event (its dispatch has not settled it) stays. A
 *   run keeps its `trigger_key` and a kernel run its `trigger_event_id` (neither has a foreign
 *   key); a chain whose event is gone restarts at depth 0.
 * - **Lost windows.** The dispatcher owes one coalesce job per window, from the delivery that opens
 *   it (`<coalesceJobIdOfKey>-<eventId>`, due `coalesceSeconds` on). A pair whose newest waiting
 *   delivery has waited longer than the org's `coalesceSeconds` plus {@link COALESCE_STALE_MS}
 *   lost its job for good (dead in the outbox, or failed in the queue): every window the
 *   dispatcher opened, the newest included, was due by then. Unless an outbox row of the pair is
 *   still pending (the dispatcher's, any `<coalesceJobIdOfKey>-*`, or an earlier sweep's), the
 *   sweep owes a coalesce job of its own (`<coalesceJobIdOfKey>-<first event id>-sweep-<minute>`,
 *   due now), backing off by the age of the pair's newest waiting delivery ({@link reoweDecision})
 *   and giving up, with one warning, once that delivery is older than {@link WINDOW_GIVE_UP_MS}.
 *   The age is the newest window's, never the oldest's: an old window given up on does not stop a
 *   newer window of the pair that lost its job from being owed one (its flush takes both). The
 *   flush is idempotent, so a duplicate finds nothing waiting.
 * - **Cause handles.** Expired `trigger_cause_handles` (`ctx.triggers.causeOf`) are deleted.
 * - **Inbox items.** An inbox item resolved, or past its expiry, more than `inbox.retentionDays`
 *   ago is deleted (an open item past its expiry already left the inbox).
 */
@Injectable()
// org-filter: deployment-wide sweeps of trigger events, waiting deliveries, cause handles and inbox
// items (LockedCron), each owed job in its own org
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

  /**
   * One sweep as of `now` (tests pass their own): how many events it deleted, windows it owed,
   * cause handles and inbox items it deleted.
   */
  async sweepAt(
    now: Date,
  ): Promise<{ deleted: number; owed: number; handles: number; inboxItems: number }> {
    const cfg = this.config.get();
    const days = cfg.automations.eventRetentionDays;
    const deleted = await this.inBatches((b) =>
      this.deleteEvents(new Date(now.getTime() - days * DAY_MS), b),
    );
    if (deleted > 0) this.log.info("old trigger events deleted", { deleted, retentionDays: days });
    let owed = 0;
    for (const w of await this.waitingWindows(now)) {
      const age = now.getTime() - w.last.getTime();
      const decision = reoweDecision(age, now.getTime());
      if (decision === "wait") continue;
      if (decision !== "owe") {
        if (decision.give_up.log)
          this.log.warn("coalescing window lost its job for a day; the sweep stops owing one", {
            orgId: w.orgId,
            automationId: w.automationId,
            subjectKey: w.subjectKey,
            waitingSince: w.first.toISOString(),
            newestSince: w.last.toISOString(),
          });
        continue;
      }
      if (await withOrgScope(w.orgId, () => this.oweFlush(w, now))) owed++;
    }
    const handles = await this.inBatches((b) => this.deleteHandles(now, b));
    const inboxDays = cfg.inbox.retentionDays;
    const inboxItems = await this.inBatches((b) =>
      this.deleteInboxItems(new Date(now.getTime() - inboxDays * DAY_MS), b),
    );
    if (inboxItems > 0)
      this.log.info("old inbox items deleted", { deleted: inboxItems, retentionDays: inboxDays });
    return { deleted, owed, handles, inboxItems };
  }

  /** Runs `batch` (one transaction each) until it deletes fewer than a full batch; the total. */
  private async inBatches(batch: (size: number) => Promise<number>): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const n = await batch(DELETE_BATCH);
      total += n;
      if (n < DELETE_BATCH) break;
    }
    return total;
  }

  /** Deletes expired cause handles, at most `limit`; returns how many. */
  @Transactional()
  private async deleteHandles(now: Date, limit: number): Promise<number> {
    const db = this.kdb.db;
    return asPlatform("deployment-wide expired trigger cause handle sweep", async () => {
      const r = await sql<{ id: string }>`
        DELETE FROM capybara.trigger_cause_handles
        WHERE id IN (
          SELECT id FROM capybara.trigger_cause_handles
          WHERE expires_at <= ${now}
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id`.execute(db);
      return r.rows.length;
    });
  }

  /** Deletes inbox items resolved or expired before `cutoff`, at most `limit`; returns how many. */
  @Transactional()
  private async deleteInboxItems(cutoff: Date, limit: number): Promise<number> {
    const db = this.kdb.db;
    return asPlatform("deployment-wide inbox item retention sweep", async () => {
      const r = await sql<{ id: string }>`
        DELETE FROM capybara.inbox_items
        WHERE id IN (
          SELECT id FROM capybara.inbox_items
          WHERE resolved_at < ${cutoff} OR expires_at < ${cutoff}
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id`.execute(db);
      return r.rows.length;
    });
  }

  /** Deletes settled events older than `cutoff` (see the class), at most `limit`; how many. */
  @Transactional()
  private async deleteEvents(cutoff: Date, limit: number): Promise<number> {
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
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id`.execute(db);
      return r.rows.length;
    });
  }

  /**
   * The pairs whose newest waiting delivery is older than their org's `coalesceSeconds` plus
   * {@link COALESCE_STALE_MS} (see the class), oldest first window first; a pair whose newest
   * waiting delivery is past {@link WINDOW_GIVE_UP_MS} by more than one sweep is left out (given up
   * on before).
   */
  private async waitingWindows(now: Date): Promise<WaitingWindow[]> {
    const db = this.kdb.db;
    // coalesceSeconds is at least 1: anything younger than the stale margin is not stale anywhere
    const older = new Date(now.getTime() - COALESCE_STALE_MS);
    const since = new Date(now.getTime() - WINDOW_GIVE_UP_MS - SWEEP_EVERY_MS);
    const rows = await asPlatform("deployment-wide lost coalescing window sweep", () =>
      sql<{
        org_id: string;
        automation_id: string;
        subject_key: string;
        first_event_id: string;
        first: Date;
        last: Date;
      }>`
        SELECT d.org_id, d.automation_id, d.subject_key,
          (array_agg(d.event_id ORDER BY d.created_at, e.created_at, e.id))[1] AS first_event_id,
          min(d.created_at) AS first, max(d.created_at) AS last
        FROM capybara.automation_event_deliveries d
        JOIN capybara.trigger_events e ON e.id = d.event_id
        WHERE d.automation_run_id IS NULL
        GROUP BY d.org_id, d.automation_id, d.subject_key
        HAVING max(d.created_at) < ${older} AND max(d.created_at) >= ${since}
        ORDER BY min(d.created_at)
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
      // the newest window the dispatcher may have opened is still due: not lost (yet)
      const last = new Date(r.last);
      if (now.getTime() - last.getTime() <= coalesceSeconds * 1000 + COALESCE_STALE_MS) continue;
      out.push({
        orgId: r.org_id,
        automationId: r.automation_id,
        subjectKey: r.subject_key,
        firstEventId: r.first_event_id,
        first: new Date(r.first),
        last,
      });
    }
    return out;
  }

  /**
   * Owes the window's coalesce job unless an outbox row of the pair (the dispatcher's for any of
   * its windows, or an earlier sweep's) is still pending; true when it owed one.
   */
  @Transactional()
  private async oweFlush(w: WaitingWindow, now: Date): Promise<boolean> {
    const db = this.kdb.db;
    const prefix = `${coalesceJobIdOfKey(w.automationId, w.subjectKey)}-`;
    const pending = await db
      .selectFrom("outbox")
      .select("id")
      .where("org_id", "=", w.orgId)
      .where("queue", "=", MAINTENANCE_QUEUE_NAME)
      .where("job_name", "=", AUTOMATION_COALESCE_JOB)
      .where(sql<boolean>`starts_with(job_id, ${prefix})`)
      // the prefix alone could also be another subject's whose kind extends this key
      .where(sql<boolean>`data->>'automationId' = ${w.automationId}`)
      .where(sql<boolean>`data->>'subjectKey' = ${w.subjectKey}`)
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
      jobId: `${prefix}${w.firstEventId}-sweep-${Math.floor(now.getTime() / 60_000)}`,
      data: { orgId: w.orgId, automationId: w.automationId, subjectKey: w.subjectKey },
      orgId: w.orgId,
    });
  }
}
