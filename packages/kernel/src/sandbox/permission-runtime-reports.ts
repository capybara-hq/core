import { createHash } from "node:crypto";
import type { SandboxPermissionSupport } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { PermissionAuthorityLock } from "./permission-authority-lock.js";
import {
  type PermissionAvailability,
  unprobedPermissionAvailability,
} from "./permission-availability.js";

const permissionScopeHash = (identity: PermissionRuntimeIdentity) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        identity.runtimeHash,
        identity.helperHash,
        identity.imageFingerprint,
        identity.instanceGeneration,
      ]),
    )
    .digest("hex");

/** Authenticated transport metadata, separate from the public provider support report. */
export interface PermissionRuntimeIdentity {
  runtimeHash: string;
  helperHash: string;
  imageFingerprint: string;
  instanceGeneration: string;
}
export function runtimeIdentity(value: unknown): PermissionRuntimeIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Runtime identity is missing");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join() !==
    ["helperHash", "imageFingerprint", "instanceGeneration", "runtimeHash"].join()
  )
    throw new Error("Incomplete runtime identity");
  for (const key of ["runtimeHash", "helperHash", "imageFingerprint"] as const)
    if (typeof v[key] !== "string" || !/^[a-f0-9]{64}$/.test(v[key]))
      throw new Error("Runtime identity requires verified hashes");
  if (
    typeof v.instanceGeneration !== "string" ||
    !v.instanceGeneration.length ||
    v.instanceGeneration.length > 256
  )
    throw new Error("Invalid runtime generation");
  return { ...v } as unknown as PermissionRuntimeIdentity;
}
/** No probe, provisioning or provider IO. A changed identity makes the previous report unprobed. */
export async function readRuntimeReport(
  db: KernelSchemaDb,
  deviceId: string,
  provider: string,
  version: string | undefined,
): Promise<PermissionAvailability> {
  if (!version) return unprobedPermissionAvailability();
  const instance = await db
    .selectFrom("device_instances")
    .select(["provider", "created_at", "permission_runtime_identity"])
    .where("device_id", "=", deviceId)
    .executeTakeFirst();
  if (!instance || instance.provider !== provider || !instance.permission_runtime_identity)
    return unprobedPermissionAvailability();
  const row = await db
    .selectFrom("device_permission_reports")
    .selectAll()
    .where("device_id", "=", deviceId)
    .executeTakeFirst();
  if (
    !row ||
    row.provider !== provider ||
    row.provider_version !== version ||
    row.instance_generation !== String(instance.created_at.getTime()) ||
    row.identity_hash !== permissionScopeHash(instance.permission_runtime_identity)
  )
    return unprobedPermissionAvailability();
  if (!row.report.restricted && !row.report.fullAccess)
    return {
      state: "unsupported",
      reason: row.report.unavailableReason ?? "This runtime cannot enforce permission operations",
    };
  return { state: "supported", report: row.report };
}
@Injectable()
export class PermissionRuntimeReports {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(PermissionAuthorityLock) private readonly locks: PermissionAuthorityLock,
  ) {}
  /** Caller holds the device authority writer lock and validates authenticated hello/source identity. */
  @Transactional({ propagation: "mandatory" })
  async record(
    deviceId: string,
    provider: string,
    version: string,
    identity: PermissionRuntimeIdentity | undefined,
    report: SandboxPermissionSupport,
  ): Promise<void> {
    this.locks.assertHeld("device", deviceId, true);
    const instance = await this.db
      .selectFrom("device_instances")
      .select(["created_at", "provider"])
      .where("device_id", "=", deviceId)
      .executeTakeFirst();
    if (!instance || instance.provider !== provider) return;
    if (!identity) {
      await this.db
        .updateTable("device_instances")
        .set({ permission_runtime_identity: null })
        .where("device_id", "=", deviceId)
        .execute();
      return;
    }
    const checked = runtimeIdentity(identity);
    if (checked.instanceGeneration !== String(instance.created_at.getTime()))
      throw new Error("Runtime report belongs to another instance generation");
    await this.db
      .updateTable("device_instances")
      .set({ permission_runtime_identity: JSON.stringify(checked) })
      .where("device_id", "=", deviceId)
      .execute();
    await this.db
      .insertInto("device_permission_reports")
      .values({
        device_id: deviceId,
        provider,
        provider_version: version,
        instance_generation: checked.instanceGeneration,
        identity_hash: permissionScopeHash(checked),
        report: JSON.stringify(report),
      })
      .onConflict((oc) =>
        oc.column("device_id").doUpdateSet({
          provider,
          provider_version: version,
          instance_generation: checked.instanceGeneration,
          identity_hash: permissionScopeHash(checked),
          report: JSON.stringify(report),
          observed_at: new Date(),
        }),
      )
      .execute();
  }
}
