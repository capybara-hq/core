import { SandboxOperationOutcomeUnknownError } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { KernelDb } from "../infra/database/kernel-db.js";
import { SandboxOperationIntents } from "./operation-intents.js";
import { SandboxProviders } from "./providers.js";
/** Called only by the maintenance consumer. It has no native dispatch or lease token API. */
@Injectable()
export class SandboxOperationReconcileJob {
  constructor(
    @Inject(SandboxOperationIntents) private readonly intents: SandboxOperationIntents,
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(SandboxProviders) private readonly providers: SandboxProviders,
  ) {}
  async reconcile(operationId: string): Promise<void> {
    await this.intents.expirePayload(operationId);
    const row = await this.intents.read(operationId);
    if (row.state === "revoked") {
      await this.revoke(operationId);
      return;
    }
    // Existing run/tool claim recovery owns continuation. A failed orphan never gets new authority.
    if (row.state === "dispatching") await this.intents.unknown(operationId);
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
