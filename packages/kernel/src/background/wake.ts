import type { Logger } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { KernelEvents } from "../infra/events/kernel-events.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import { RunQueue } from "../runtime/run-queue.js";

/**
 * Wakes an idle conversation when one of its background tasks finished (spec
 * 2026-11-05-background-bash-design §3) or a sub-agent delivered to it (agent map spec §5.3).
 * {@link BackgroundTaskFinisher} announces the committed finish (`background_task.finished`) and
 * `SubagentDeliveries` the committed delivery (`subagent.delivered`), both in-process domain
 * events emitted after the commit; {@link onFinished} asks the run queue for a run. The wake rules
 * themselves (own task, not reported, the wake setting, the root's queue not paused, the trigger
 * account can still send to the root, the 60 s window and its delayed `bg-wake` job) are applied
 * by `RunQueue.ensureRun` in its transaction (`wakeDecisionIn`, ./wake-rules.ts), so a run's end,
 * the delayed job and a page opening apply the same rules; a lost event is re-derived by the next
 * of them. Provided by `RuntimeModule`.
 */
@Injectable()
export class BackgroundWake implements OnApplicationShutdown {
  /** Drops the subscriptions (the events may outlive this instance). */
  private readonly unsubscribe: (() => void)[];

  constructor(
    @Inject(RunQueue) private readonly runs: Pick<RunQueue, "ensureRun">,
    @Inject(KernelEvents) events: KernelEvents,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<Logger, "warn">,
  ) {
    this.unsubscribe = [
      events.on("background_task.finished", ({ conversationId }) =>
        this.onFinished(conversationId),
      ),
      events.on("subagent.delivered", ({ conversationId }) => this.onFinished(conversationId)),
    ];
  }

  /**
   * A task of `conversationId` finished, or a sub-agent delivered to it (after the commit): starts
   * a wake run when the rules allow it, or schedules one at the end of the wake window. A run in
   * progress absorbs the event at its next step instead, or its end starts the wake. Never throws.
   */
  async onFinished(conversationId: string): Promise<void> {
    try {
      await this.runs.ensureRun(conversationId);
    } catch (err) {
      this.log.warn("background wake failed", { conversationId, err });
    }
  }

  onApplicationShutdown(): void {
    for (const off of this.unsubscribe) off();
  }
}
