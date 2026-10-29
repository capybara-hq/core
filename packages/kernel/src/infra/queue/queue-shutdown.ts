import { WorkerHost } from "@nestjs/bullmq";
import { type BeforeApplicationShutdown, Inject, Injectable, Optional } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";
import { Queue, type Worker } from "bullmq";
import type { KernelLogger } from "../../log.js";
import { closeWithin } from "../close-within.js";
import { GracefulShutdown } from "../lifecycle/graceful-shutdown.service.js";
import { KERNEL_LOGGER } from "../tokens.js";

/** The least time a queue or worker gets to close when the stop budget is used up. */
const MIN_CLOSE_MS = 1_000;

/**
 * Closes every BullMQ queue (`registerQueue`) and `@Processor` worker of the application within
 * what is left of the stop budget, before `@nestjs/bullmq` closes them again in
 * `onApplicationShutdown` without a limit: a close waits for Redis (a worker's blocking read, the
 * `QUIT`), which never answers while Redis is down. What does not close in time is abandoned like
 * the infra closes (`closeWithin`): its disconnect is tried, and the later close returns at once,
 * so the application's shutdown never hangs on a queue.
 */
@Injectable()
export class QueueShutdown implements BeforeApplicationShutdown {
  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    @Optional() @Inject(GracefulShutdown) private readonly shutdown?: GracefulShutdown,
  ) {}

  async beforeApplicationShutdown(): Promise<void> {
    const targets: { label: string; target: Queue | Worker }[] = [];
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (instance instanceof Queue) {
        targets.push({ label: `queue ${instance.name}`, target: instance });
      } else if (instance instanceof WorkerHost) {
        // a processor whose worker was never built (no registration) has nothing to close
        let worker: Worker | undefined;
        try {
          worker = instance.worker;
        } catch {
          worker = undefined;
        }
        if (worker) targets.push({ label: `worker ${worker.name}`, target: worker });
      }
    }
    const budget = Math.max(MIN_CLOSE_MS, this.shutdown?.remainingMs() ?? MIN_CLOSE_MS);
    await Promise.all(
      targets.map(async ({ label, target }) => {
        if (await closeWithin(label, target.close(), budget, this.log)) return;
        // Abandoned, as the infra closes are: the disconnect is tried (not awaited: it waits for
        // the connection too), and the later close by @nestjs/bullmq returns at once instead of
        // awaiting a close that only ends when Redis answers again (a worker's main loop retries
        // its blocked command until then)
        void target.disconnect().catch(() => {});
        Object.defineProperty(target, "close", { value: () => Promise.resolve() });
      }),
    );
  }
}
