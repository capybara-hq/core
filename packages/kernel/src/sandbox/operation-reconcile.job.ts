import {
  isSandboxPermissionUnsupportedError,
  isSandboxScopeDeniedError,
  parseSandboxExecutionRef,
  parseSandboxOperationScope,
  type SandboxExecutionRef,
  SandboxOperationOutcomeUnknownError,
  SandboxPermissionUnsupportedError,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { MANAGED_STOP_GRACE_MS, ManagedInstanceMismatchError } from "../background/managed.js";
import { BackgroundTaskStopper } from "../background/stop.js";
import { BackgroundTaskStore } from "../background/store.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import { isDeviceRequestNotSent } from "../local-devices/relay.js";
import type { KernelLogger } from "../log.js";
import { checkManagedStart, type ManagedStartArgs } from "./held-operations.js";
import { type OperationIntent, SandboxOperationIntents } from "./operation-intents.js";
import { SandboxProviders } from "./providers.js";
import { SandboxService } from "./sandbox.service.js";

/**
 * What an operation's in-sandbox time limit leaves beyond `sandbox.limits.maxCommandSeconds`
 * after its admission deadline (the margin a holder record keeps too).
 */
const OPERATION_END_MARGIN_MS = 10 * 60_000;

/** Called only by the maintenance consumer. It has no native dispatch or lease token API. */
@Injectable()
export class SandboxOperationReconcileJob {
  constructor(
    @Inject(SandboxOperationIntents) private readonly intents: SandboxOperationIntents,
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(SandboxProviders) private readonly providers: SandboxProviders,
    @Inject(SandboxService) private readonly sandbox: Pick<SandboxService, "ifRunning">,
    @Inject(BackgroundTaskStore)
    private readonly tasks: Pick<BackgroundTaskStore, "byOperation" | "settleOwedCancel">,
    @Inject(BackgroundTaskStopper) private readonly stopper: Pick<BackgroundTaskStopper, "stop">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    /** Where a recovered start's refusal keeps the provider's own message (never the task's). */
    @Optional() @Inject(KERNEL_LOGGER) private readonly log?: Pick<KernelLogger, "warn">,
  ) {}
  async reconcile(operationId: string): Promise<void> {
    await this.intents.expirePayload(operationId);
    const row = await this.intents.read(operationId);
    if (row.method === "backgroundStart") {
      await this.reconcileBackground(row);
      return;
    }
    if (row.state === "revoked") {
      await this.revoke(operationId);
      return;
    }
    // Existing run/tool claim recovery owns continuation. A failed orphan never gets new authority.
    if (row.state === "dispatching") await this.intents.unknown(operationId);
  }
  /**
   * A managed start: past its retention an unresolved launch is given up (terminal task, owed
   * exact revoke); a revoked one owes its revoke; a `dispatching` one still has its dispatcher
   * (or a holder cleanup that revokes it) and is only checked again later; a `started-or-unknown`
   * one is recovered under the same identity.
   */
  private async reconcileBackground(row: OperationIntent): Promise<void> {
    if (row.retain_until.getTime() <= Date.now()) {
      await this.intents.abandonBackgroundLaunch(row.operation_id, "expired");
      const now = await this.intents.read(row.operation_id);
      if (now.state === "revoked" && !now.revoke_acknowledged) await this.revoke(row.operation_id);
      return;
    }
    if (row.state === "revoked") {
      await this.revoke(row.operation_id);
      return;
    }
    if (row.state === "dispatching") {
      await this.intents.deferBackgroundRecovery(row.operation_id);
      return;
    }
    if (row.state === "started-or-unknown") await this.recoverBackground(row.operation_id);
  }
  /**
   * Recovers a managed start whose acknowledgement was lost, under a task-specific recovery claim:
   * asks the provider about the same operation, recorded scope and recorded input on the exact
   * recorded provider, version and instance generation only (never resumed), after the same
   * artifact and runtime checks as the first dispatch. A launch that happened returns its original
   * ref; one that did not happens once. Never a new operation ID, never refreshed authority.
   */
  async recoverBackground(operationId: string): Promise<void> {
    const claimed = await this.intents.claimBackgroundRecovery(operationId);
    if (!claimed) return;
    // set by the callback: a refusal from the checks and one from the provider settle differently
    const at: { phase: "check" | "start" } = { phase: "check" };
    try {
      const input = (await this.intents.input(claimed)) as Omit<ManagedStartArgs, "signal"> | null;
      if (!input || typeof input !== "object")
        throw new SandboxOperationOutcomeUnknownError("The recorded start input has expired");
      const scope = parseSandboxOperationScope(claimed.scope);
      const generation = Number(claimed.instance_generation);
      const instance = await this.db
        .selectFrom("device_instances")
        .select("provider")
        .where("device_id", "=", claimed.device_id)
        .executeTakeFirst();
      const entry = this.providers.forName(claimed.provider);
      if (
        !Number.isSafeInteger(generation) ||
        instance?.provider !== claimed.provider ||
        !entry ||
        (entry.version ?? "internal-v2") !== claimed.provider_version
      )
        throw new SandboxOperationOutcomeUnknownError(
          "The recorded provider or instance is not current; the start outcome remains unknown",
        );
      const r = await this.sandbox.ifRunning(
        claimed.device_id,
        { createdAt: new Date(generation) },
        async (p, h, signal): Promise<{ ref: SandboxExecutionRef; instanceId: string }> => {
          await checkManagedStart(p as unknown as SandboxProvider, h, scope, input, signal);
          const background = p.background;
          if (!background)
            throw new SandboxPermissionUnsupportedError("Managed background tasks are unavailable");
          at.phase = "start";
          return {
            ref: await background.start(h, scope, {
              ...input,
              // a bound (local) device knows its generation from its binding; a cloud one is told
              ...(!entry.binder && { instanceGeneration: claimed.instance_generation }),
              signal,
            }),
            instanceId: h.id,
          };
        },
        AbortSignal.timeout(60_000),
      );
      if (r.kind !== "ran")
        throw new SandboxOperationOutcomeUnknownError(
          "The recorded instance is not running; the start outcome remains unknown",
        );
      await this.intents.acknowledgeBackground(
        operationId,
        claimed.execution_id,
        r.value.ref,
        r.value.instanceId,
      );
    } catch (error) {
      // never sent (the device's connection changed): nothing learned about the first dispatch
      if (isDeviceRequestNotSent(error)) {
        await this.intents.deferBackgroundRecovery(operationId);
        return;
      }
      if (at.phase === "check" && isSandboxScopeDeniedError(error)) {
        // The kernel will not send it again, but cannot prove the first dispatch had no effect.
        await this.intents.abandonBackgroundLaunch(operationId, "refused");
        return;
      }
      if (
        at.phase === "start" &&
        (isSandboxScopeDeniedError(error) || isSandboxPermissionUnsupportedError(error))
      ) {
        // the task keeps the kernel's reason; the provider's message stays here
        this.log?.warn("a recovered background start was refused", { operationId, err: error });
        await this.intents.settleBackgroundRefusal(operationId, claimed.execution_id, {
          // a not-sent refusal was deferred above; kept distinct should it ever reach here
          kind: isDeviceRequestNotSent(error)
            ? "not_sent"
            : isSandboxScopeDeniedError(error)
              ? "denied"
              : "unsupported",
          message: error.message,
        });
        return;
      }
      await this.intents.deferBackgroundRecovery(operationId);
    }
  }
  async revoke(operationId: string): Promise<void> {
    try {
      await this.revokeOnce(operationId);
    } catch {
      await this.intents.deferRevocation(operationId);
    }
  }
  private async revokeOnce(operationId: string): Promise<void> {
    const row = await this.intents.read(operationId);
    if (row.state !== "revoked" || row.revoke_acknowledged) return;
    // a launched background start is cancelled by its exact ref, never by the operation revoke;
    // one revoked before its ref is known keeps the exact operation revoke below
    if (row.method === "backgroundStart" && row.execution_ref !== null) {
      await this.revokeBackground(row);
      return;
    }
    const instance = await this.db
      .selectFrom("device_instances")
      .select(["provider", "handle", "created_at"])
      .where("device_id", "=", row.device_id)
      .executeTakeFirst();
    // Do not use a new instance as proof that the old execution was cleaned up.
    if (
      !instance?.handle ||
      instance.provider !== row.provider ||
      String(instance.created_at.getTime()) !== row.instance_generation
    ) {
      // ... only the old incarnation's own end (a start may outlive both: its exact stop or the
      // retirement settles it)
      if (row.method !== "backgroundStart" && (await this.incarnationEnded(row))) {
        await this.intents.acknowledgeRevocation(operationId);
        return;
      }
      throw new SandboxOperationOutcomeUnknownError(
        "The revoked operation's instance must be reconciled before cleanup is acknowledged",
      );
    }
    const provider = this.providers.forName(row.provider)?.impl;
    if (!provider?.revokeOperation)
      throw new SandboxOperationOutcomeUnknownError(
        "The operation's provider is unavailable; revocation remains owed",
      );
    await provider.revokeOperation(
      instance.handle,
      { operationId: row.operation_id, admitBeforeMs: row.deadline.getTime() },
      AbortSignal.timeout(30_000),
    );
    await this.intents.acknowledgeRevocation(operationId);
  }
  /**
   * Whether a foreground operation (exec, read, write) of an incarnation that no longer runs has
   * provably ended, so its owed revoke has nothing left to reach: the provider confirmed that
   * incarnation's destruction (recorded in `device_instance_destructions`), or the operation is
   * past its device-enforced bound (admitted before its deadline, then cut by the in-sandbox time
   * limit of `maxCommandSeconds`). Both read only PostgreSQL and the clock, so every replica
   * decides alike; without either the revoke stays owed.
   */
  private async incarnationEnded(row: OperationIntent): Promise<boolean> {
    const destroyed = await this.db
      .selectFrom("device_instance_destructions")
      .select("device_id")
      .where("device_id", "=", row.device_id)
      .where("provider", "=", row.provider)
      .where("instance_generation", "=", row.instance_generation)
      .executeTakeFirst();
    if (destroyed) return true;
    const maxCommandMs = this.config.get().sandbox.limits.maxCommandSeconds * 1000;
    return Date.now() > row.deadline.getTime() + maxCommandMs + OPERATION_END_MARGIN_MS;
  }
  /**
   * The exact cancellation a revoked background start owes (design B3): the task's own stop by its
   * exact ref with the five-second grace, which settles and reports the task; the revocation is
   * acknowledged only on verified settlement (a stop or an exit). A pending cancellation, an
   * unreachable or replaced instance and lost supervision keep it owed. The intent alone carries
   * the obligation: a finished-lost task or a task row removed with its conversation is still
   * stopped by the intent's recorded ref on the recorded instance generation, never by a PID, a
   * tag or a newer instance.
   */
  private async revokeBackground(row: OperationIntent): Promise<void> {
    const owed = (why: string) =>
      new SandboxOperationOutcomeUnknownError(`${why}; the exact cancellation remains owed`);
    const ref = parseSandboxExecutionRef(row.execution_ref);
    const task = await this.tasks.byOperation(row.operation_id);
    if (task?.status === "running") {
      const after = await this.stopper.stop(task, "revoked", AbortSignal.timeout(30_000));
      if (after.status === "running") throw owed("The task's stop is pending or claimed elsewhere");
      if (after.launchState === "terminal") {
        await this.intents.acknowledgeRevocation(row.operation_id);
        return;
      }
    } else if (task?.launchState === "terminal" && task.status !== "lost") {
      // a verified end (an exit, a stop, a refusal); a `lost` task (a launch revoked or given
      // up before its ref was known) proves nothing about the process: stopped by the ref below
      await this.intents.acknowledgeRevocation(row.operation_id);
      return;
    }
    const generation = Number(row.instance_generation);
    if (
      !Number.isSafeInteger(generation) ||
      ref.operationId !== row.operation_id ||
      ref.instanceGeneration !== row.instance_generation
    )
      throw owed("The recorded execution reference does not match its start");
    const r = await this.sandbox.ifRunning(
      row.device_id,
      // the exact stop of a revoked start: an exact-ref drain (8.5)
      { createdAt: new Date(generation), exactRef: true },
      async (p, h, signal) => {
        if (h.id !== ref.instanceId) throw new ManagedInstanceMismatchError();
        if (!p.background)
          throw new SandboxPermissionUnsupportedError("Managed background tasks are unavailable");
        return p.background.stop(h, ref, { graceMs: MANAGED_STOP_GRACE_MS, signal });
      },
      AbortSignal.timeout(30_000),
    );
    if (r.kind !== "ran") throw owed("The recorded instance is not running");
    if (r.value.outcome !== "stopped" && r.value.outcome !== "already-exited")
      throw owed(`The device answered ${r.value.outcome}`);
    if (task) await this.tasks.settleOwedCancel(task.id);
    await this.intents.acknowledgeRevocation(row.operation_id);
  }
}
