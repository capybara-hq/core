import { Inject, Injectable } from "@nestjs/common";
import { EventLog } from "../conversations/event-log.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LAST_LINES_MAX_CHARS } from "./session.js";
import { type BackgroundTaskRow, BackgroundTaskStore } from "./store.js";
import { BackgroundWake } from "./wake.js";

/** Where a task ends (as {@link BackgroundTaskStore.finish} takes it). */
export type BackgroundFinish = Parameters<BackgroundTaskStore["finish"]>[1];

/** The idempotency key of a task's `background_task_finished` event. */
export const finishedEventKey = (taskId: string): string => `background_task_finished:${taskId}`;

/**
 * Takes a task out of `running` (spec 2026-11-05-background-bash-design §4.3): one transaction holds
 * the conditional status update and the `background_task_finished` event of the owning
 * conversation, so a crash between them cannot lose the event, and of two paths finishing the same
 * task (two pollers, a poll and a stop) exactly one writes it. After the commit: the log's notify,
 * the `changed: "background"` frame (to the owner and, for a sub-agent's task, the conversation
 * that owns the sandbox, whose panel lists it too) and {@link BackgroundWake.onFinished}.
 *
 * Holds no lock and runs no sandbox command: the caller reads `lastLines` before.
 */
@Injectable()
export class BackgroundTaskFinisher {
  constructor(
    @Inject(BackgroundTaskStore) private readonly store: Pick<BackgroundTaskStore, "finish">,
    @Inject(EventLog) private readonly eventLog: EventLog,
    @Inject(BackgroundWake) private readonly wake: BackgroundWake,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /**
   * Finishes `task` as `to` with its last output lines (cut to their last 4 000 characters);
   * `reported` when a tool call already told the model in its run. False (nothing written) when the
   * task was no longer running, or, with `opts.unclaimed` (the poller), when a live stop claimed it:
   * the stop's finish is then the only one.
   */
  @Transactional()
  async finish(
    task: BackgroundTaskRow,
    to: BackgroundFinish,
    lastLines: string,
    reported: boolean,
    opts: { unclaimed?: boolean } = {},
  ): Promise<boolean> {
    if (!(await this.store.finish(task.id, to, opts))) return false;
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
          outputPath: `/workspace/${task.outputPath}`,
          reported,
          ...(to.lostReason !== undefined && { lostReason: to.lostReason }),
        },
      },
    ]);
    const conversations = [...new Set([task.conversationId, task.sandboxConversationId])];
    afterCommit(async () => {
      if (event) await this.eventLog.notify(task.conversationId, event.seq);
      for (const c of conversations) await this.eventLog.publishChanged(c, "background");
      await this.wake.onFinished(task.conversationId);
    });
    return true;
  }
}
