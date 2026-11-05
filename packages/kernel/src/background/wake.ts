import type { Logger } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { KernelEvents } from "../infra/events/kernel-events.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import { RunQueue } from "../runtime/run-queue.js";

/**
 * Wakes an idle conversation when one of its background tasks finished (spec
 * 2026-11-05-background-bash-design §3). {@link BackgroundTaskFinisher} announces the committed
 * finish (`background_task.finished`, an in-process domain event: the finisher's module sits
 * below the runtime); {@link onFinished} asks the run queue for a run. The wake rules themselves
 * (own task, not reported, the wake setting, the queue not paused, the trigger account can still
 * send, the 60 s window and its delayed `bg-wake` job) are applied by `RunQueue.ensureRun` in its
 * transaction (`wakeDecisionIn`, ./wake-rules.ts), so a run's end, the delayed job and a page
 * opening apply the same rules. Provided by `RuntimeModule`.
 */
@Injectable()
export class BackgroundWake implements OnApplicationShutdown {
  /** Drops the subscription (the events may outlive this instance). */
  private readonly unsubscribe: () => void;

  constructor(
    @Inject(RunQueue) private readonly runs: Pick<RunQueue, "ensureRun">,
    @Inject(KernelEvents) events: KernelEvents,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<Logger, "warn">,
  ) {
    this.unsubscribe = events.on("background_task.finished", ({ conversationId }) =>
      this.onFinished(conversationId),
    );
  }

  /**
   * A task of `conversationId` finished (after the commit): starts a wake run when the rules
   * allow it, or schedules one at the end of the wake window. A run in progress absorbs the finish
   * at its next step instead, or its end starts the wake. Never throws.
   */
  async onFinished(conversationId: string): Promise<void> {
    try {
      await this.runs.ensureRun(conversationId);
    } catch (err) {
      this.log.warn("background task wake failed", { conversationId, err });
    }
  }

  onApplicationShutdown(): void {
    this.unsubscribe();
  }
}
