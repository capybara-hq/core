import { Inject, Injectable } from "@nestjs/common";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedInterval } from "../infra/schedule/locked-interval.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { LoopbackGrants } from "./loopback-grants.js";

/** The expiry pass of loopback port grants (`@LockedInterval`, every {@link LOOPBACK_EXPIRY_MS}). */
export const LOOPBACK_EXPIRY_JOB = "device-loopback-expiry";
/** The pass's period. */
export const LOOPBACK_EXPIRY_MS = 60_000;

/**
 * Ends the loopback port grants past their 24 hours (browser loopback port grants design §4) and
 * owes the refresh of each service that held one: once per tick across replicas
 * (`@LockedInterval`), provided only by the worker role (`WorkerModule`).
 */
@Injectable()
export class LoopbackExpiryJob {
  constructor(
    @Inject(LoopbackGrants) private readonly grants: Pick<LoopbackGrants, "expireDue">,
    @Inject(KernelConfigService) readonly config: KernelConfigService,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedInterval(LOOPBACK_EXPIRY_JOB, () => LOOPBACK_EXPIRY_MS)
  async expire(): Promise<void> {
    await this.grants.expireDue();
  }
}
