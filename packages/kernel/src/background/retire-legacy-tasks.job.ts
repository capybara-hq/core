import { Inject, Injectable } from "@nestjs/common";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedInterval } from "../infra/schedule/locked-interval.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { LegacyRetirementStore, type RetirementMember } from "../sandbox/legacy-retirement.js";
import { SandboxOperationIntents } from "../sandbox/operation-intents.js";
import { SandboxService } from "../sandbox/sandbox.service.js";
import { BackgroundTaskStore } from "./store.js";

/** The job's name (`@LockedInterval`, run lock `cron:background-retire-legacy-tasks`). */
export const RETIRE_LEGACY_TASKS_JOB = "background-retire-legacy-tasks";

/** Every minute, once per tick across replicas. */
const PERIOD_MS = 60_000;
/** Devices one tick tries (each one exclusive lease and at most one provider destroy each). */
export const RETIRE_DEVICES_PER_TICK = 10;
/** Members of resolved obligations one tick settles. */
const SETTLE_PER_TICK = 100;
/** The run lock outlives the slowest tick: a destroy per device. */
const TICK_TTL_MS = 15 * 60_000;

/** What one run did. */
export interface RetireLegacyResult {
  /** New obligation members the enumeration recorded. */
  added: number;
  /** Devices left without an unresolved obligation. */
  cleared: number;
  /** Devices still unavailable (quarantined, or a destroy that failed). */
  unavailable: number;
  /** Devices held by someone: their next lifecycle acquisition runs the gate inline. */
  busy: number;
  /** Members whose own records were settled. */
  settled: number;
  /** Obligations abandoned with their deleted devices this tick. */
  abandoned: number;
}

/**
 * Legacy retirement (permission runtime cutover phase 8.5), once per tick across replicas:
 * 1. enumerates, until a pass adds nothing ({@link LegacyRetirementStore.scanUntilStable}),
 *    the legacy rows (once the legacy-launch freeze is published) and the revoked managed starts
 *    on incarnations that no longer run, as members of their device incarnation's obligation;
 * 2. for up to {@link RETIRE_DEVICES_PER_TICK} devices with an obligation due (backoff per
 *    attempt), runs the sandbox service's retirement gate under one try at the exclusive
 *    lifecycle lease (`SandboxService.retireLegacy`): a cloud incarnation is destroyed whole by its
 *    provider, a local or unverifiable one is quarantined, a failure keeps the obligation;
 * 3. settles the members of resolved obligations: a revoked start's revocation is acknowledged
 *    and its task's owed cancellation settled (`settleOwedCancel`; finish and event stay the
 *    task's own), a legacy row's `kill_pending` is cleared (no process of a confirmed destroyed
 *    incarnation can exist).
 * Retryable and bounded; the job missing or late never lets a device be used: every lifecycle
 * acquisition runs the same gate inline.
 */
@Injectable()
export class RetireLegacyTasksJob {
  constructor(
    @Inject(LegacyRetirementStore)
    private readonly retirement: Pick<
      LegacyRetirementStore,
      "scanUntilStable" | "due" | "unsettledMembers" | "markSettled" | "abandonDeleted"
    >,
    @Inject(SandboxService) private readonly sandbox: Pick<SandboxService, "retireLegacy">,
    @Inject(SandboxOperationIntents)
    private readonly intents: Pick<SandboxOperationIntents, "acknowledgeRevocation">,
    @Inject(BackgroundTaskStore)
    private readonly tasks: Pick<
      BackgroundTaskStore,
      "byOperation" | "settleOwedCancel" | "clearKill"
    >,
    @Inject(KernelConfigService) readonly config: KernelConfigService,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedInterval(RETIRE_LEGACY_TASKS_JOB, () => PERIOD_MS, { ttl: TICK_TTL_MS })
  async tick(signal?: AbortSignal): Promise<void> {
    const r = await this.runOnce(signal);
    if (r.added + r.cleared + r.unavailable + r.settled + r.abandoned > 0)
      this.log.info("legacy retirement tick", { ...r });
  }

  /** One run (see the class); `signal` (the stop, or a lost run lock) is read between devices. */
  async runOnce(signal?: AbortSignal): Promise<RetireLegacyResult> {
    const result: RetireLegacyResult = {
      added: 0,
      cleared: 0,
      unavailable: 0,
      busy: 0,
      settled: 0,
      abandoned: 0,
    };
    result.added = (await this.retirement.scanUntilStable()).added;
    // obligations of deleted devices: resolved by a recorded confirmed destroy, else abandoned
    // (never evidence; no device can reuse them)
    result.abandoned = (await this.retirement.abandonDeleted()).abandoned;
    for (const deviceId of await this.retirement.due(RETIRE_DEVICES_PER_TICK)) {
      if (signal?.aborted) return result;
      try {
        const outcome = await this.sandbox.retireLegacy(deviceId, signal);
        if (outcome === "clear") result.cleared++;
        else if (outcome === "unavailable") result.unavailable++;
        else result.busy++;
      } catch (err) {
        // retried at a later tick; the inline gate keeps the device closed meanwhile
        this.log.warn("legacy retirement failed; will retry", { deviceId, err });
        result.unavailable++;
      }
    }
    for (const m of await this.retirement.unsettledMembers(SETTLE_PER_TICK)) {
      if (signal?.aborted) return result;
      try {
        if (await this.settle(m)) {
          await this.retirement.markSettled(m);
          result.settled++;
        }
      } catch (err) {
        this.log.warn("cannot settle a retired legacy member; will retry", {
          kind: m.kind,
          ref: m.refId,
          err,
        });
      }
    }
    return result;
  }

  /** Settles one member of a resolved obligation; false while its task still runs. */
  private async settle(m: RetirementMember): Promise<boolean> {
    if (m.kind === "legacy-task") {
      await this.tasks.clearKill([m.refId]);
      return true;
    }
    await this.intents.acknowledgeRevocation(m.refId);
    const task = await this.tasks.byOperation(m.refId);
    if (!task) return true;
    await this.tasks.settleOwedCancel(task.id);
    const after = await this.tasks.byOperation(m.refId);
    return after === undefined || after.launchState !== "cancel-pending";
  }
}
