import { Inject, Injectable, Module } from "@nestjs/common";
import { KERNEL_LOGGER } from "../../infra/tokens.js";
import type { KernelLogger } from "../../log.js";
import type { TriggerDispatchJobData } from "../job-ids.js";

/**
 * Routes one stored trigger event to the automations it fires (collaboration spec §4.4, §4.7).
 * TODO(collaboration B5): the routing itself; until then a dispatch job only logs, so an owed job
 * completes and its event stays `pending`.
 */
@Injectable()
export class TriggerDispatcher {
  constructor(@Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "info">) {}

  async dispatch(data: TriggerDispatchJobData): Promise<void> {
    this.log.info("trigger event dispatch is not implemented yet", {
      orgId: data.orgId,
      eventId: data.eventId,
    });
  }
}

/** The trigger event dispatcher, for the maintenance processor (worker role only). */
@Module({ providers: [TriggerDispatcher], exports: [TriggerDispatcher] })
export class TriggerDispatchModule {}
