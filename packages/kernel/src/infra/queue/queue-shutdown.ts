import { WorkerHost } from "@nestjs/bullmq";
import { type BeforeApplicationShutdown, Inject, Injectable, Optional } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";
import { Queue, type Worker } from "bullmq";
import type { KernelLogger } from "../../log.js";
import { closeWithin } from "../close-within.js";
import { GracefulShutdown } from "../lifecycle/graceful-shutdown.service.js";
import { KERNEL_LOGGER } from "../tokens.js";

/** The least time a queue or worker gets to close when the stop budget is used up. */
export const MIN_CLOSE_MS = 1_000;

/** What is kept of the stop budget for the infra closes that follow (bus, Redis, the pool). */
export const INFRA_RESERVE_MS = 2_000;

/**
 * Closes every BullMQ queue (`registerQueue`) and `@Processor` worker of the application within
 * what is left of the stop budget (less {@link INFRA_RESERVE_MS}), before `@nestjs/bullmq` closes
 * them again in `onApplicationShutdown` without a limit. A close waits for Redis, which never
 * answers while Redis is down:
 * - a queue is registered with `forceDisconnectOnShutdown` (`QueueModule.registerQueue`), and one
 *   that does not close in time is disconnected here;
 * - a worker has no such option, and its close also waits for its main loop, which retries its
 *   blocked command until Redis answers again: one that does not close in time is disconnected
 *   and abandoned like the infra closes (`closeWithin`), its later close returning at once (the
 *   one monkeypatch: otherwise `@nestjs/bullmq`'s own close would hold the application's close).
 */
@Injectable()
export class QueueShutdown implements BeforeApplicationShutdown {
  constructor(
    @Inject(DiscoveryService) private readonly discovery: Pick<DiscoveryService, "getProviders">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    @Optional()
    @Inject(GracefulShutdown)
    private readonly shutdown?: Pick<GracefulShutdown, "remainingMs">,
  ) {}

  async beforeApplicationShutdown(): Promise<void> {
    const targets: { label: string; target: Queue | Worker; worker: boolean }[] = [];
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (instance instanceof Queue) {
        targets.push({ label: `queue ${instance.name}`, target: instance, worker: false });
      } else if (instance instanceof WorkerHost) {
        // a processor whose worker was never built (no registration) has nothing to close
        let worker: Worker | undefined;
        try {
          worker = instance.worker;
        } catch {
          worker = undefined;
        }
        if (worker) targets.push({ label: `worker ${worker.name}`, target: worker, worker: true });
      }
    }
    const left = this.shutdown?.remainingMs() ?? MIN_CLOSE_MS + INFRA_RESERVE_MS;
    const budget = Math.max(MIN_CLOSE_MS, left - INFRA_RESERVE_MS);
    await Promise.all(
      targets.map(async ({ label, target, worker }) => {
        if (await closeWithin(label, target.close(), budget, this.log)) return;
        // not awaited: the disconnect itself waits for the connection
        void target.disconnect().catch(() => {});
        if (worker) Object.defineProperty(target, "close", { value: () => Promise.resolve() });
      }),
    );
  }
}
