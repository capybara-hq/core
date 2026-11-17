import { Inject, Injectable } from "@nestjs/common";
import { EventLog } from "../conversations/event-log.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KernelEvents } from "../infra/events/kernel-events.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { oweEnsureRun } from "../runtime/run-jobs.js";
import { OPERATION_REVOKE } from "../sandbox/operation-intents.js";
import { taskOutputFile } from "./launch.js";
import { LAST_LINES_MAX_CHARS } from "./session.js";
import { type BackgroundTaskRow, BackgroundTaskStore, isManagedTask } from "./store.js";

/** Where a task ends (as {@link BackgroundTaskStore.finish} takes it). */
export type BackgroundFinish = Parameters<BackgroundTaskStore["finish"]>[1];

/**
 * Who stopped a task, when its finish must never wake the conversation: a person (who is looking at
 * it), the deletion of the conversation, or the end of the sub-agent that owns it (a fork's run, a
 * stopped background sub-agent).
 */
export type BackgroundStoppedBy = "person" | "deletion" | "subagent_end";

/** The idempotency key of a task's `background_task_finished` event. */
export const finishedEventKey = (taskId: string): string => `background_task_finished:${taskId}`;

/**
 * Takes a task out of `running` (spec 2026-11-05-background-bash-design §4.3): one transaction holds
 * the conditional status update and the `background_task_finished` event of the owning
 * conversation, so a crash between them cannot lose the event, and of two paths finishing the same
 * task (two pollers, a poll and a stop) exactly one writes it. After the commit: the log's notify,
 * the `changed: "background"` frame (to the owner and, for a sub-agent's task, the conversation
 * that owns the sandbox, whose panel lists it too) and the `background_task.finished` domain event
 * (`BackgroundWake` wakes an idle conversation; it lives in the runtime, above this module). A
 * finish that may wake the conversation also owes the ensure-run backstop in the transaction.
 *
 * Holds no lock and runs no sandbox command: the caller reads `lastLines` before.
 */
@Injectable()
export class BackgroundTaskFinisher {
  constructor(
    @Inject(BackgroundTaskStore) private readonly store: Pick<BackgroundTaskStore, "finish">,
    @Inject(EventLog) private readonly eventLog: EventLog,
    @Inject(KernelEvents) private readonly events: KernelEvents,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    @Inject(KernelDb) private readonly db: KernelDb,
  ) {}

  /**
   * Finishes `task` as `to` with its last output lines (cut to their last 4 000 characters);
   * `reported` when a tool call already told the model in its run. False (nothing written) when the
   * task was no longer running, or, with `opts.unclaimed` (the poller), when a live stop claimed it:
   * the stop's finish is then the only one. `opts.stoppedBy` marks a stop that must never wake the
   * conversation: `"person"` (a person stopped it) or `"deletion"` (its conversation is being
   * deleted).
   *
   * A managed task (permission runtime cutover phase 8.3) settles its durable launch state in the
   * same transaction: a verified end (an exit, a stop) is `terminal` and retires its start intent's
   * running authority (`background-running` to `completed`, so no revocation selects it again); a
   * lost one keeps `cancel-pending` and its intent, an obligation that outlives the finish. The
   * intent row is locked before the task row, the order every authority writer takes.
   */
  @Transactional()
  async finish(
    task: BackgroundTaskRow,
    to: BackgroundFinish,
    lastLines: string,
    reported: boolean,
    opts: { unclaimed?: boolean; stoppedBy?: BackgroundStoppedBy } = {},
  ): Promise<boolean> {
    const managed = isManagedTask(task)
      ? to.status === "lost"
        ? ("cancel-pending" as const)
        : ("terminal" as const)
      : undefined;
    if (managed !== undefined && task.operationId !== null)
      await this.db
        .selectFrom("sandbox_operation_intents")
        .select("operation_id")
        .where("operation_id", "=", task.operationId)
        .forUpdate()
        .executeTakeFirst();
    if (
      !(await this.store.finish(task.id, to, {
        ...(opts.unclaimed !== undefined && { unclaimed: opts.unclaimed }),
        ...(managed !== undefined && { managed }),
      }))
    )
      return false;
    if (managed === "terminal" && task.operationId !== null)
      await this.db
        .updateTable("sandbox_operation_intents")
        .set({ state: "completed", updated_at: new Date() })
        .where("operation_id", "=", task.operationId)
        .where("state", "=", "background-running")
        .execute();
    // A lost end (supervision lost, instance gone or replaced) is no proof the process is gone:
    // its running authority is retired and the exact cancellation is owed to the revoke worker,
    // which acknowledges it only on a verified stop (an unresolvable one waits for retirement).
    if (managed === "cancel-pending" && task.operationId !== null) {
      const retired = await this.db
        .updateTable("sandbox_operation_intents")
        .set({ state: "revoked", outcome_unknown: true, updated_at: new Date() })
        .where("operation_id", "=", task.operationId)
        .where("state", "=", "background-running")
        .returning("operation_id")
        .executeTakeFirst();
      if (retired)
        await this.outbox.add({
          queue: "cap-kernel-maintenance",
          name: OPERATION_REVOKE,
          jobId: `${OPERATION_REVOKE}-${retired.operation_id}`,
          data: { operationId: retired.operation_id },
          orgId: task.orgId,
        });
    }
    const [event] = await this.eventLog.appendIn(task.conversationId, [
      {
        type: "background_task_finished",
        idemKey: finishedEventKey(task.id),
        payload: {
          taskId: task.id,
          description: task.description,
          status: to.status,
          exitCode: to.exitCode ?? null,
          elapsedMs: Math.max(0, Date.now() - task.startedAt.getTime()),
          lastLines:
            lastLines.length > LAST_LINES_MAX_CHARS
              ? lastLines.slice(-LAST_LINES_MAX_CHARS)
              : lastLines,
          outputPath: taskOutputFile(task.outputPath),
          reported,
          ...(to.lostReason !== undefined && { lostReason: to.lostReason }),
          ...(opts.stoppedBy !== undefined && { stoppedBy: opts.stoppedBy }),
        },
      },
    ]);
    // a finish that may wake the conversation owes the ensure-run backstop with its event: the
    // wake after the commit (`BackgroundWake`) may never happen (transactional outbox spec §6)
    if (event && !reported && opts.stoppedBy === undefined) {
      await oweEnsureRun(this.outbox, task.conversationId, event.seq, task.orgId);
    }
    const conversations = [...new Set([task.conversationId, task.sandboxConversationId])];
    afterCommit(async () => {
      if (event) await this.eventLog.notify(task.conversationId, event.seq);
      for (const c of conversations) await this.eventLog.publishChanged(c, "background");
      await this.events.emit("background_task.finished", { conversationId: task.conversationId });
    });
    return true;
  }
}
