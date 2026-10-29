import { Inject, Injectable } from "@nestjs/common";
import { KernelEvents } from "../infra/events/kernel-events.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { RunAbort } from "./abort.js";
import { RunQueue } from "./run-queue.js";
import { Waits } from "./waits.js";

/**
 * Starting and stopping runs from outside the run worker: the conversations API (a message, a
 * stop), the conversation queue and offboarding (a departed member's runs, `by: null`).
 */
@Injectable()
export class RunControl {
  constructor(
    @Inject(RunQueue) private readonly queue: Pick<RunQueue, "ensureRun" | "abortIfOrphaned">,
    @Inject(Waits)
    private readonly waits: Pick<Waits, "abortWaiting" | "childFinished" | "stopChildren">,
    @Inject(RunAbort) private readonly abort: Pick<RunAbort, "request">,
    @Inject(KernelEvents) private readonly events: KernelEvents,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "error">,
  ) {}

  /** 有未消费的消息且没有进行中的运行时投递一轮运行；返回 runId 或 null。 */
  ensureRun(conversationId: string): Promise<string | null> {
    return this.queue.ensureRun(conversationId);
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
   * 运行已不是 waiting（例如刚被续跑）→ false. Either way its approval / question cards may have
   * changed: `run.wait-stopped` lets the channel outbound update them.
   */
  async abortWaiting(
    conversationId: string,
    runId: string,
    byAccountId: string | null,
  ): Promise<boolean> {
    const r = await this.waits.abortWaiting(conversationId, runId, byAccountId);
    await this.events.emit("run.wait-stopped", { conversationId, runId });
    return r;
  }

  /** 请求中止运行（广播到所有副本）。 */
  requestAbort(runId: string, byAccountId: string | null): Promise<void> {
    return this.abort.request(runId, byAccountId);
  }
}
