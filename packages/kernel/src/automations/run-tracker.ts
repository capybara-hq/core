import { Inject, Injectable, Module } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { PushOwed, PushOwedModule } from "../push/push-owed.js";
import { readAutomationSettings } from "./effective-settings.js";
import { pauseTaskIn } from "./pause.js";
import type { TaskRun } from "./types.js";

/** How a kernel run ended (`runs.status` once terminal). */
export type RunOutcome = "completed" | "failed" | "aborted";

/** The kernel run statuses that are terminal (`runtime/run-finish.ts`, not imported: a cycle). */
const RUN_TERMINAL: ReadonlySet<string> = new Set<RunOutcome>(["completed", "failed", "aborted"]);

/**
 * How long a task run that was started (its message created or queued) may show no trace of its
 * message before the overlap check releases it: the fire job writes `fired_at` before it creates
 * the conversation or queues the item, in a transaction of its own.
 */
export const START_GRACE_MS = 5 * 60_000;

/** The columns of a task run the tracker settles. */
interface TaskRunRow {
  id: string;
  automation_id: string;
  org_id: string;
  trial: boolean;
}

/**
 * Follows a task run's kernel run to its end (scheduled tasks spec §6). {@link onRunFinished} runs
 * in the transaction that writes a run's terminal state (`RunFinish.finishIn`, the one writer of
 * terminal states), so a task run never misses its run's end: a run aborted by a person counts as
 * completed; a failed one counts against the task (`consecutive_failures`, paused at the org's
 * `pauseAfterFailures`), a completed one resets the count. Trial runs do not count.
 * {@link inFlightIn} is the overlap check's view of the task's previous run: it settles a run whose
 * end was missed and releases one whose queued message is gone.
 */
@Injectable()
// org-filter: kernel-internal (run finish, fire job, settle job): task run ids come from a kernel
// run's automation_run_id or from a task run row the caller already holds, never from input
export class AutomationRunTracker {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    /** Owes the task owner's push (`automations`) with every settle. */
    @Inject(PushOwed) private readonly push: Pick<PushOwed, "oweAutomationRun">,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * The kernel run `runId` ended with `outcome`: the task run it was started for (the run its
   * message triggered, `automation_runs.run_id`) takes the outcome. A sub-agent or wake run
   * that inherited the marker is not the task run's own and changes nothing.
   */
  @Transactional()
  async onRunFinished(runId: string, outcome: RunOutcome, error?: string): Promise<void> {
    const run = await this.db
      .selectFrom("runs")
      .select("automation_run_id")
      .where("id", "=", runId)
      .executeTakeFirst();
    const taskRunId = run?.automation_run_id;
    if (taskRunId == null) return;
    const owner = await this.db
      .selectFrom("automation_runs")
      .select("automation_id")
      .where("id", "=", taskRunId)
      .executeTakeFirst();
    if (!owner) return;
    // lock order task row → task run, as the fire job's claim takes them (no lock cycle)
    await lockTaskRow(this.db, owner.automation_id);
    const tr = await this.db
      .selectFrom("automation_runs")
      .select(["id", "automation_id", "org_id", "trial", "status", "run_id"])
      .where("id", "=", taskRunId)
      .forUpdate()
      .executeTakeFirst();
    if (!tr || tr.run_id !== runId || tr.status !== "running") return;
    await this.settle(tr, outcome, error);
  }

  /**
   * Whether `prev`, a run of the task still `pending` or `running`, is really in flight (the
   * overlap check, inside the fire's transaction). Settled on the way: a running one whose kernel
   * run already ended takes its outcome; a started one linked to its run now when the run exists;
   * a started one whose message another run consumed (`consumed_seq`, no run of its own) ends
   * `completed`; a started one with no queued item, no message and no run after {@link START_GRACE_MS} (its
   * queued item was removed or the queue cleared without the queue's own hook) becomes `skipped`
   * (`removed`). The marker alone decides what is the task's message, never a client message id.
   */
  @Transactional({ propagation: "mandatory" })
  async inFlightIn(prev: TaskRun, now: Date = new Date()): Promise<boolean> {
    const t = this.db;
    await lockTaskRow(t, prev.taskId);
    const tr = await t
      .selectFrom("automation_runs")
      .selectAll()
      .where("id", "=", prev.id)
      .forUpdate()
      .executeTakeFirst();
    if (!tr || (tr.status !== "pending" && tr.status !== "running")) return false;
    if (tr.status === "running") {
      if (tr.run_id === null) return true;
      const run = await t
        .selectFrom("runs")
        .select("status")
        .where("id", "=", tr.run_id)
        .executeTakeFirst();
      if (!run) {
        await this.settle(tr, "failed", "The run was lost");
        return false;
      }
      if (!RUN_TERMINAL.has(run.status)) return true;
      await this.settle(tr, run.status as RunOutcome);
      return false;
    }
    // not claimed yet: its fire job is still to come (the run's unfired settle check skips it
    // when the job failed for good before its claim)
    if (tr.fired_at === null) return true;
    // only a run with a target conversation is ever queued (`conversation`, `chat`, `subject`):
    // no scan of every queue's markers for the others
    const queued =
      tr.conversation_id === null
        ? undefined
        : await t
            .selectFrom("conversation_queue")
            .select("id")
            .where("conversation_id", "=", tr.conversation_id)
            .where(
              sql<string>`coalesce(schedule ->> 'taskRunId', automation_event ->> 'automationRunId')`,
              "=",
              tr.id,
            )
            .limit(1)
            .executeTakeFirst();
    if (queued) return true;
    const conv =
      tr.conversation_id ??
      (
        await t
          .selectFrom("conversations")
          .select("id")
          .where("org_id", "=", tr.org_id)
          .where("automation_id", "=", tr.automation_id)
          .where("create_request_id", "=", tr.id)
          .executeTakeFirst()
      )?.id;
    if (conv !== undefined) {
      const run = await t
        .selectFrom("runs")
        .select(["id", "status"])
        .where("conversation_id", "=", conv)
        .where("automation_run_id", "=", tr.id)
        .orderBy("created_at")
        .limit(1)
        .executeTakeFirst();
      if (run) {
        await t
          .updateTable("automation_runs")
          .set({ status: "running", run_id: run.id, conversation_id: conv })
          .where("id", "=", tr.id)
          .where("org_id", "=", tr.org_id)
          .execute();
        if (!RUN_TERMINAL.has(run.status)) return true;
        await this.settle(tr, run.status as RunOutcome);
        return false;
      }
      const message = await t
        .selectFrom("conversation_events")
        .select("seq")
        .where("conversation_id", "=", conv)
        .where("type", "=", "user_message")
        .where(
          sql<string>`coalesce(payload -> 'schedule' ->> 'taskRunId', payload -> 'automationEvent' ->> 'automationRunId')`,
          "=",
          tr.id,
        )
        .limit(1)
        .executeTakeFirst();
      if (message) {
        const c = await t
          .selectFrom("conversations")
          .select("consumed_seq")
          .where("id", "=", conv)
          .where("org_id", "=", tr.org_id)
          .executeTakeFirst();
        // posted, its run still to be created (`ensureRun`)
        if (c === undefined || Number(message.seq) > Number(c.consumed_seq)) return true;
        // taken in by another run (a person's message posted with it): its content was handled
        // and no run of its own will come, so it ends as completed rather than in flight forever
        await this.settle(tr, "completed");
        return false;
      }
    }
    const firedAt = tr.fired_at instanceof Date ? tr.fired_at : new Date(tr.fired_at);
    if (now.getTime() - firedAt.getTime() < START_GRACE_MS) return true;
    await t
      .updateTable("automation_runs")
      .set({ status: "skipped", skip_reason: "removed", fired_at: null })
      .where("id", "=", tr.id)
      .where("org_id", "=", tr.org_id)
      .where("status", "=", "pending")
      .execute();
    return false;
  }

  /**
   * A pending task run whose start was refused (the fire job could not create or queue its
   * message, for a reason that is not a lasting skip): it fails and counts against the task like
   * a failed run (`consecutive_failures`, paused at the org's `pauseAfterFailures`), a trial run
   * excepted. In the caller's transaction, which holds the task row.
   */
  @Transactional({ propagation: "mandatory" })
  async failStartIn(taskRunId: string, error: string): Promise<void> {
    const tr = await this.db
      .selectFrom("automation_runs")
      .select(["id", "automation_id", "org_id", "trial", "status"])
      .where("id", "=", taskRunId)
      .forUpdate()
      .executeTakeFirst();
    if (tr?.status !== "pending") return;
    await this.settle(tr, "failed", error);
  }

  /**
   * Writes the task run's end, owes the owner's push (trial runs too) and writes the task's failure
   * count (non-trial runs).
   */
  private async settle(tr: TaskRunRow, outcome: RunOutcome, error?: string): Promise<void> {
    const t = this.db;
    const failed = outcome === "failed";
    await t
      .updateTable("automation_runs")
      .set({
        status: failed ? "failed" : "completed",
        ...(failed && { error: error ?? "The run failed" }),
      })
      .where("id", "=", tr.id)
      .where("org_id", "=", tr.org_id)
      .execute();
    await this.push.oweAutomationRun(tr.id, tr.org_id);
    if (tr.trial) return;
    if (!failed) {
      await t
        .updateTable("automations")
        .set({ consecutive_failures: 0 })
        .where("id", "=", tr.automation_id)
        .where("org_id", "=", tr.org_id)
        .where("consecutive_failures", "!=", 0)
        .execute();
      return;
    }
    const row = await t
      .updateTable("automations")
      .set({ consecutive_failures: sql<number>`consecutive_failures + 1` })
      .where("id", "=", tr.automation_id)
      .where("org_id", "=", tr.org_id)
      .where("deleted_at", "is", null)
      .returning("consecutive_failures")
      .executeTakeFirst();
    if (!row) return;
    const settings = await readAutomationSettings(t, this.config, tr.org_id);
    if (row.consecutive_failures >= settings.pauseAfterFailures) {
      await pauseTaskIn(t, tr.automation_id, "failures", null);
    }
  }
}

/**
 * A kernel run was created for task run `taskRunId` (its message is the run's trigger, or it
 * inherited the marker): a task run still `pending` takes the run (`running`), in the caller's
 * transaction (`RunQueue.ensureRunIn`, which inserts the run). A task run already linked (a
 * sub-agent or wake run inheriting the marker) is left alone.
 */
// org-filter: the task run id is the kernel-written schedule or event marker of the run's trigger
// message (automationRunAt), set only through the kernel-internal options, never by a person
export async function linkStartedRunIn(
  t: KernelSchemaDb,
  taskRunId: string,
  runId: string,
  conversationId: string,
): Promise<void> {
  await t
    .updateTable("automation_runs")
    .set({
      status: "running",
      run_id: runId,
      conversation_id: sql<string>`COALESCE(conversation_id, ${conversationId})`,
    })
    .where("id", "=", taskRunId)
    .where("status", "=", "pending")
    .where("run_id", "is", null)
    .execute();
}

/**
 * The automation run a queued item's stored marker names: its schedule marker's `taskRunId`, or
 * its event marker's `automationRunId` (collaboration spec §4.6); undefined for a person's item.
 */
export function queuedAutomationRunId(item: {
  schedule: unknown;
  automation_event: unknown;
}): string | undefined {
  const fromSchedule = (item.schedule as { taskRunId?: unknown } | null)?.taskRunId;
  if (typeof fromSchedule === "string") return fromSchedule;
  const fromEvent = (item.automation_event as { automationRunId?: unknown } | null)
    ?.automationRunId;
  return typeof fromEvent === "string" ? fromEvent : undefined;
}

/**
 * A person removed, edited or sent the queued item that carried a schedule or event marker (the
 * item's stored columns): its task run will never run as the task's, so it becomes `skipped`
 * (`removed`) in the caller's transaction, and the next tick is not held by the overlap check.
 */
// org-filter: the marker is the queued item's stored schedule / automation_event column, written
// only through the kernel-internal options of the queue (never from a request body)
export async function releaseQueuedTaskRunIn(
  t: KernelSchemaDb,
  item: { schedule: unknown; automation_event: unknown },
): Promise<void> {
  const taskRunId = queuedAutomationRunId(item);
  if (taskRunId === undefined) return;
  await t
    .updateTable("automation_runs")
    .set({ status: "skipped", skip_reason: "removed", fired_at: null })
    .where("id", "=", taskRunId)
    .where("status", "=", "pending")
    .where("run_id", "is", null)
    .execute();
}

/**
 * Locks a task's row (deleted or not) in the caller's transaction. Every path that locks a task
 * run and the task takes the task row first: the fire job's claim, the run tracker, the scan's
 * repair (a run finishing while the next tick's claim checks overlap must not deadlock).
 */
// org-filter: a row lock by the task id of a task or task run row the kernel caller already holds
export async function lockTaskRow(t: KernelSchemaDb, taskId: string): Promise<void> {
  await t
    .selectFrom("automations")
    .select("id")
    .where("id", "=", taskId)
    .forUpdate()
    .executeTakeFirst();
}

/** The run tracker alone: the runtime (`RunFinish`) imports it without the automations service. */
@Module({
  imports: [PushOwedModule],
  providers: [AutomationRunTracker],
  exports: [AutomationRunTracker],
})
export class AutomationTrackerModule {}
