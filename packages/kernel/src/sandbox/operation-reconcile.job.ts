import {
  parseSandboxOperationScope,
  type SandboxExecutionRef,
  SandboxOperationOutcomeUnknownError,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { KernelDb } from "../infra/database/kernel-db.js";
import type { ManagedStartArgs } from "./held-operations.js";
import { SandboxOperationIntents } from "./operation-intents.js";
import { SandboxProviders } from "./providers.js";
import { SandboxService } from "./sandbox.service.js";
/** Called only by the maintenance consumer. It has no native dispatch or lease token API. */
@Injectable()
export class SandboxOperationReconcileJob {
  constructor(
    @Inject(SandboxOperationIntents) private readonly intents: SandboxOperationIntents,
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(SandboxProviders) private readonly providers: SandboxProviders,
    @Inject(SandboxService) private readonly sandbox: Pick<SandboxService, "ifRunning">,
  ) {}
  async reconcile(operationId: string): Promise<void> {
    await this.intents.expirePayload(operationId);
    const row = await this.intents.read(operationId);
    if (row.state === "revoked") {
      await this.revoke(operationId);
      return;
    }
    if (
      row.method === "backgroundStart" &&
      (row.state === "dispatching" || row.state === "started-or-unknown")
    ) {
      await this.recoverBackground(operationId);
      return;
    }
    // Existing run/tool claim recovery owns continuation. A failed orphan never gets new authority.
    if (row.state === "dispatching") await this.intents.unknown(operationId);
  }
  /**
   * Recovers a managed start whose acknowledgement was lost, under a task-specific recovery claim:
   * asks the provider about the same operation, recorded scope and recorded input on the exact
   * recorded instance only (never resumed, never another generation), so a launch that happened
   * returns its original ref and one that did not happens once. Never a new operation ID, never
   * refreshed authority. Anything short of an acknowledgement keeps the uncertainty and retries.
   */
  async recoverBackground(operationId: string): Promise<void> {
    const claimed = await this.intents.claimBackgroundRecovery(operationId);
    if (!claimed) return;
    try {
      const input = (await this.intents.input(claimed)) as Omit<ManagedStartArgs, "signal"> | null;
      if (!input || typeof input !== "object")
        throw new SandboxOperationOutcomeUnknownError("The recorded start input has expired");
      const scope = parseSandboxOperationScope(claimed.scope);
      const generation = Number(claimed.instance_generation);
      if (!Number.isSafeInteger(generation))
        throw new SandboxOperationOutcomeUnknownError("The recorded instance is not addressable");
      const r = await this.sandbox.ifRunning(
        claimed.device_id,
        { createdAt: new Date(generation) },
        async (p, h, signal): Promise<{ ref: SandboxExecutionRef; instanceId: string }> => {
          if (!p.background)
            throw new SandboxOperationOutcomeUnknownError(
              "Managed background tasks are unavailable",
            );
          return {
            ref: await p.background.start(h, scope, { ...input, signal }),
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
    } catch {
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
    )
      throw new SandboxOperationOutcomeUnknownError(
        "The revoked operation's instance must be reconciled before cleanup is acknowledged",
      );
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
}
