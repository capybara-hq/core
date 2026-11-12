import { Inject, Injectable } from "@nestjs/common";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { RunAbort } from "./abort.js";
import { type ResumeOutcome, RunResume } from "./run-jobs.js";
import { RunQueue } from "./run-queue.js";
import { oweStopDeletedTree } from "./subagents/tree-jobs.js";
import { Waits } from "./waits.js";

/**
 * Starting and stopping runs from outside the run worker: the conversations API (a message, a
 * stop), the conversation queue and offboarding (a departed member's runs, `by: null`).
 */
@Injectable()
export class RunControl {
  constructor(
    @Inject(RunQueue)
    private readonly queue: Pick<
      RunQueue,
      "ensureRun" | "oweEnsureRun" | "abortIfOrphaned" | "wakeHeldTree" | "oweHeldTreeIn"
    >,
    @Inject(Waits)
    private readonly waits: Pick<
      Waits,
      "abortWaiting" | "childFinished" | "stopChildren" | "stopTree"
    >,
    @Inject(RunAbort) private readonly abort: Pick<RunAbort, "request">,
    /** The resume of a waiting run in a decision's transaction (a reply's skips). */
    @Inject(RunResume) private readonly resumes: Pick<RunResume, "resumeIn">,
    /** Owes a deleted root's tree stop in the delete's transaction. */
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "error">,
  ) {}

  /** 有未消费的消息且没有进行中的运行时投递一轮运行；返回 runId 或 null。 */
  ensureRun(conversationId: string): Promise<string | null> {
    return this.queue.ensureRun(conversationId);
  }

  /**
   * The direct `ensureRun` right after a commit that owes the ensure-run backstop (a message, a
   * queue change): a failure (Redis unreachable) is logged and never thrown, since the committed
   * write is not undone and the backstop starts the run later (transactional outbox spec §6).
   */
  async ensureRunAfterCommit(conversationId: string): Promise<void> {
    try {
      await this.queue.ensureRun(conversationId);
    } catch (err) {
      this.log.error("cannot start the conversation's run now; the ensure-run backstop will", {
        conversationId,
        err,
      });
    }
  }

  /**
   * Owes the ensure-run backstop in the caller's transaction (transactional outbox spec §6): `seq`
   * is the event it wrote (or the conversation's newest), `orgId` the conversation's.
   */
  oweEnsureRun(conversationId: string, seq: number | string, orgId: string): Promise<boolean> {
    return this.queue.oweEnsureRun(conversationId, seq, orgId);
  }

  /** After a root's queue was unpaused: the wakes it held for its tree ({@link RunQueue.wakeHeldTree}). */
  wakeHeldTree(rootId: string): Promise<void> {
    return this.queue.wakeHeldTree(rootId);
  }

  /**
   * Owes, in the transaction that may release a root's hold (an unpause, a "send now"), the
   * ensure-run backstop of every sub-agent the hold kept waiting ({@link RunQueue.oweHeldTreeIn});
   * the caller's {@link wakeHeldTree} after the commit is the direct call.
   */
  oweHeldTreeIn(rootId: string): Promise<void> {
    return this.queue.oweHeldTreeIn(rootId);
  }

  /**
   * In the caller's transaction, after it locked the decided rows (lock order: conversations,
   * decided rows, runs): resumes the waiting run `runId` when it waits on nothing else
   * ({@link RunResume.resumeIn}).
   */
  resumeIn(runId: string, waitId: string): Promise<ResumeOutcome> {
    return this.resumes.resumeIn(runId, waitId);
  }

  /**
   * Owes, in a root's delete transaction, the stop of its whole sub-agent tree (`stop-tree`,
   * transactional outbox spec §6); the caller's {@link stopTree} after the commit is the direct
   * call.
   */
  oweStopDeletedTree(
    conversationId: string,
    byAccountId: string | null,
    orgId: string,
  ): Promise<boolean> {
    return oweStopDeletedTree(this.outbox, conversationId, byAccountId, orgId);
  }

  /**
   * 运行是孤儿（会话锁空闲、任务已不存在，没有 worker 会收到中止广播）时直接把它写成 aborted，返回 true；
   * 否则返回 false。A stopped sub-agent then reports to its parent at once, and a stopped parent
   * stops its children (sub-agents spec §12).
   */
  async abortIfOrphaned(
    conversationId: string,
    runId: string,
    byAccountId: string | null,
  ): Promise<boolean> {
    const r = await this.queue.abortIfOrphaned(conversationId, runId, byAccountId);
    if (r) {
      await this.waits
        .childFinished(runId)
        .catch((err) =>
          this.log.error("cannot report finished sub-agent run to its parent", { runId, err }),
        );
      await this.waits
        .stopChildren(runId, null)
        .catch((err) => this.log.error("cannot stop the sub-agents of a run", { runId, err }));
    }
    return r;
  }

  /**
   * 运行在等人处理（waiting）时直接中止：取消等待、写 `run_aborted`、删除 checkpoint，返回 true；
   * 运行已不是 waiting（例如刚被续跑）→ false. The stop's transaction owes the IM delivery that
   * updates its approval / question cards (its appends, transactional outbox spec §8.1).
   */
  abortWaiting(
    conversationId: string,
    runId: string,
    byAccountId: string | null,
  ): Promise<boolean> {
    return this.waits.abortWaiting(conversationId, runId, byAccountId);
  }

  /**
   * Stops a sub-agent with its descendants, or with `includeSelf: false` only the sub-agent
   * conversations below `conversationId` (agent map spec §6; {@link Waits.stopTree}). Returns
   * the number of runs asked to stop.
   */
  stopTree(
    conversationId: string,
    byAccountId: string | null,
    opts: { includeSelf?: boolean } = {},
  ): Promise<number> {
    return this.waits.stopTree(conversationId, byAccountId, opts);
  }

  /** 请求中止运行（广播到所有副本）。 */
  requestAbort(runId: string, byAccountId: string | null): Promise<void> {
    return this.abort.request(runId, byAccountId);
  }
}
