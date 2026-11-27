import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { TransactionHost } from "../../infra/database/transaction-host.js";
import { Transactional } from "../../infra/database/transactional.decorator.js";
import { OutboxService } from "../../infra/outbox/outbox.service.js";
import { KERNEL_LOGGER } from "../../infra/tokens.js";
import type { KernelLogger } from "../../log.js";
import { readAutomationSettings } from "../effective-settings.js";
import {
  type AutomationCoalesceJobData,
  oweAutomationFire,
  oweAutomationSettleUnfired,
} from "../job-ids.js";
import { AutomationStore } from "../store.js";

const HOUR_MS = 60 * 60_000;

/**
 * Ends one coalescing window of an event automation (collaboration spec §4.7), the
 * `automation-coalesce` job: under the automation row lock, the deliveries of the (automation,
 * subject) pair still waiting for a run, in the order their events were stored, become one run
 * keyed by the first event (`trigger_key`). A pair that already made
 * `maxEventRunsPerSubjectPerHour` runs (not skipped) in the last hour gets a run skipped with
 * `subject_rate` instead, so the drop is visible in the run list. A pending run owes its
 * `automation-fire` job and its unfired check, as a "run now" does; everything else (paused, rate
 * limit, overlap, the start) is the fire job's.
 */
@Injectable()
export class EventCoalescer {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(AutomationStore) private readonly store: AutomationStore,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "info">,
  ) {}

  /** Flushes the waiting deliveries of the pair (see the class); nothing when none wait. */
  @Transactional()
  async flush(data: AutomationCoalesceJobData): Promise<void> {
    const { orgId, automationId, subjectKey } = data;
    const db = this.kdb.db;
    // the dispatcher takes the same row before it looks for a window: no delivery lands between
    // the read below and the run that takes it
    const task = await this.store.lockTask(db, orgId, automationId);
    if (task === null) return;
    const waiting = await db
      .selectFrom("automation_event_deliveries as d")
      .innerJoin("trigger_events as e", "e.id", "d.event_id")
      .select("d.event_id")
      .where("d.org_id", "=", orgId)
      .where("d.automation_id", "=", automationId)
      .where("d.subject_key", "=", subjectKey)
      .where("d.automation_run_id", "is", null)
      .orderBy("e.created_at")
      .orderBy("e.id")
      .execute();
    const first = waiting[0];
    if (first === undefined) return;
    const settings = await readAutomationSettings(db, this.config, orgId);
    const since = new Date(Date.now() - HOUR_MS);
    const made = await db
      .selectFrom("automation_runs as r")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("r.org_id", "=", orgId)
      .where("r.automation_id", "=", automationId)
      .where("r.status", "!=", "skipped")
      .where("r.created_at", ">=", since)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("automation_event_deliveries as s")
            .select(sql`1`.as("one"))
            .whereRef("s.automation_run_id", "=", "r.id")
            .where("s.subject_key", "=", subjectKey),
        ),
      )
      .executeTakeFirstOrThrow();
    const limited = Number(made.n) >= settings.maxEventRunsPerSubjectPerHour;
    const run = await this.store.insertRun(db, {
      id: randomUUID(),
      taskId: automationId,
      orgId,
      scheduledFor: null,
      triggerKey: first.event_id,
      trial: false,
      ...(limited && { status: "skipped" as const, skipReason: "subject_rate" as const }),
    });
    // the first event is waiting, so no run took it yet: a taken key is a broken invariant
    if (run === null) throw new Error(`event ${first.event_id} already keys a run of ${task.id}`);
    await db
      .updateTable("automation_event_deliveries")
      .set({ automation_run_id: run.id })
      .where("org_id", "=", orgId)
      .where("automation_id", "=", automationId)
      .where(
        "event_id",
        "in",
        waiting.map((w) => w.event_id),
      )
      .execute();
    if (limited) {
      this.log.info("event automation run skipped: the subject's hourly run limit is reached", {
        orgId,
        automationId,
        subjectKey,
        taskRunId: run.id,
        events: waiting.length,
      });
      return;
    }
    await oweAutomationFire(this.outbox, run.id, orgId);
    await oweAutomationSettleUnfired(this.outbox, run.id, orgId, null, null);
  }
}
