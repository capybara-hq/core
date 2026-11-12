import { Inject, Injectable } from "@nestjs/common";
import type { KernelLogger } from "../../log.js";
import { KernelConfigService } from "../config/kernel-config.service.js";
import { LockService } from "../lock/lock.service.js";
import { LockedInterval } from "../schedule/locked-interval.js";
import { KERNEL_LOGGER } from "../tokens.js";
import { OutboxDispatcher } from "./outbox.dispatcher.js";

/** The relay's `@LockedInterval` job name, also its run lock key (`lock:outbox-relay`). */
export const OUTBOX_RELAY_JOB = "outbox-relay";
/** The relay's period: a fixed constant, not a config field. */
export const OUTBOX_RELAY_PERIOD_MS = 2000;
/** Rows one claim pass of the relay takes. */
export const OUTBOX_RELAY_BATCH = 500;
/** Most claim passes in one tick; what is left waits for the next tick. */
export const OUTBOX_RELAY_MAX_ROUNDS = 10;

/**
 * The outbox relay (transactional outbox spec §3.3), on the worker role only: once per tick across
 * replicas it delivers the due rows the fast path did not (a failed or skipped pass, a process that
 * died after the commit, a retry whose backoff ran out). A tick runs passes of
 * {@link OUTBOX_RELAY_BATCH} rows until one handles fewer (the backlog is drained) or
 * {@link OUTBOX_RELAY_MAX_ROUNDS} have run, and stops early when the run is aborted.
 */
@Injectable()
export class OutboxRelay {
  constructor(
    @Inject(OutboxDispatcher) private readonly dispatcher: Pick<OutboxDispatcher, "dispatchDue">,
    @Inject(KernelConfigService) readonly config: KernelConfigService,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedInterval(OUTBOX_RELAY_JOB, () => OUTBOX_RELAY_PERIOD_MS, { lockKey: OUTBOX_RELAY_JOB })
  async relay(signal?: AbortSignal): Promise<void> {
    await this.relayOnce(signal);
  }

  /** One tick's passes (the body of {@link relay}); returns the rows delivered. */
  async relayOnce(signal?: AbortSignal): Promise<number> {
    let sent = 0;
    for (let round = 0; round < OUTBOX_RELAY_MAX_ROUNDS; round++) {
      if (signal?.aborted) break;
      const r = await this.dispatcher.dispatchDue(OUTBOX_RELAY_BATCH);
      sent += r.sent;
      // rows handled: `dead` is a part of `failed`, not counted again
      if (r.sent + r.failed < OUTBOX_RELAY_BATCH) break;
    }
    if (sent > 0) this.log.debug("outbox relay delivered rows", { rows: sent });
    return sent;
  }
}
