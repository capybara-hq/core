import { DEFAULT_SANDBOX_ROOTS, type SandboxRoots } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { UpdateObject } from "kysely";
import type { KernelDatabase } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { SandboxLockLostError } from "./leases.js";
import { PermissionCeilingWrites } from "./permission-ceiling-writes.js";

const rootKey = (r: SandboxRoots) => JSON.stringify([r.workspace, r.skills, r.tmp]);
/** Final handle publication only; provider IO stays under the caller's exclusive lease outside this transaction. */
@Injectable()
export class PermissionInstanceWrites {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(PermissionCeilingWrites) private readonly ceilings: PermissionCeilingWrites,
  ) {}
  @Transactional({ propagation: "requires_new" })
  async commitHandle(
    orgId: string,
    deviceId: string,
    generation: number,
    roots: SandboxRoots,
    set: UpdateObject<KernelDatabase, "device_instances">,
    signal: AbortSignal,
  ): Promise<Date> {
    signal.throwIfAborted();
    await this.ceilings.lock({ orgId, deviceId }, "device");
    const row = await this.db
      .selectFrom("device_instances")
      .select(["generation", "permission_roots"])
      .where("device_id", "=", deviceId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.generation !== generation)
      throw new SandboxLockLostError(deviceId, "generation");
    if (rootKey(row.permission_roots ?? DEFAULT_SANDBOX_ROOTS) !== rootKey(roots))
      await this.ceilings.publishLocked({ orgId, deviceId }, "device", true, true);
    signal.throwIfAborted();
    const updated = await this.db
      .updateTable("device_instances")
      .set({ ...set, permission_roots: JSON.stringify(roots), generation: generation + 1 })
      .where("device_id", "=", deviceId)
      .where("generation", "=", generation)
      .returning("created_at")
      .executeTakeFirst();
    if (!updated) throw new SandboxLockLostError(deviceId, "generation");
    return updated.created_at;
  }
}
