import { createHash } from "node:crypto";
import {
  parseSandboxPermissionSupport,
  type SandboxHandle,
  type SandboxPermissionSupport,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { canonicalJson } from "../tools/canonical-json.js";
import { type AppliedLimits, readInstanceLimits } from "./modes.js";
import { PermissionAuthorityLock } from "./permission-authority-lock.js";
import {
  type PermissionAvailability,
  unprobedPermissionAvailability,
} from "./permission-availability.js";
import { LOCAL_PROVIDER } from "./providers.js";

export const sameRuntimeIdentity = (a: PermissionRuntimeIdentity, b: PermissionRuntimeIdentity) =>
  permissionScopeHash(a) === permissionScopeHash(b);
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
const sha256 = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

/**
 * The kernel-built runtime identity of a cloud instance (B-15, Q1 option A). A cloud provider is
 * an in-process extension (full trust), so its own permission support report, bound to these
 * kernel facts, is the strongest evidence available without an SDK change: the provider plugin
 * and version (`runtimeHash`), the committed instance handle (`helperHash`), the recorded applied
 * limits with no provider-attested image digest (`imageFingerprint`) and the instance generation.
 * Any of them changing makes a recorded report unprobed.
 */
export function cloudRuntimeIdentity(input: {
  provider: string;
  version: string;
  handle: SandboxHandle;
  instanceGeneration: string;
  applied: AppliedLimits;
}): PermissionRuntimeIdentity {
  return {
    runtimeHash: sha256({
      kind: "cloud-provider",
      provider: input.provider,
      version: input.version,
    }),
    helperHash: sha256({ kind: "cloud-instance", handle: input.handle }),
    imageFingerprint: sha256({
      kind: "cloud-environment",
      applied: {
        mode: input.applied.mode,
        network: {
          kind: input.applied.network.kind,
          hosts: [...new Set(input.applied.network.hosts)].sort(),
        },
      },
      imageDigest: null,
    }),
    instanceGeneration: input.instanceGeneration,
  };
}

/**
 * A permission support report strictly parsed (`parseSandboxPermissionSupport`, version 2), or null
 * when it is not one: a cloud provider's answer (an in-process extension is trusted, but its answer
 * is stored and read back later, so nothing beyond the contract's fields is kept) and a stored
 * report read back (one recorded before version 2 is no report).
 */
export function cloudSupportOf(value: unknown): SandboxPermissionSupport | null {
  try {
    return parseSandboxPermissionSupport(value);
  } catch {
    return null;
  }
}

/**
 * The cloud identity the instance row proves now, or null when it proves none: no live instance
 * of this provider, no handle or no recorded applied limits.
 */
function currentCloudIdentity(
  instance: {
    provider: string | null;
    status: string;
    handle: SandboxHandle | null;
    created_at: Date;
    instance_limits: unknown;
  },
  provider: string,
  version: string,
): PermissionRuntimeIdentity | null {
  const applied = readInstanceLimits(instance.instance_limits).applied;
  if (
    instance.provider !== provider ||
    !instance.handle ||
    applied === null ||
    (instance.status !== "running" && instance.status !== "suspended")
  )
    return null;
  return cloudRuntimeIdentity({
    provider,
    version,
    handle: instance.handle,
    instanceGeneration: String(instance.created_at.getTime()),
    applied,
  });
}

/**
 * What a cloud instance can enforce of its provider's report (B-12, spec §124): Full access needs
 * the instance itself to hold the outer boundary. An instance applied in the OS sandbox mode
 * holds its outer network only through the restricted child filters that Full access leaves, so
 * Full reads as unsupported there whatever the provider reports; restricted support stands.
 */
export function cloudEnforceable(
  report: SandboxPermissionSupport,
  instanceLimits: unknown,
): SandboxPermissionSupport {
  if (!report.outsideSandbox || readInstanceLimits(instanceLimits).applied?.mode === "auto")
    return report;
  return {
    ...report,
    outsideSandbox: false,
    unavailableReason:
      "This cloud instance enforces its outer network only inside the OS sandbox, so it cannot run Full access",
  };
}

/** No probe, provisioning or provider IO. A changed identity makes the previous report unprobed. */
export async function readRuntimeReport(
  db: KernelSchemaDb,
  deviceId: string,
  provider: string,
  version: string | undefined,
): Promise<PermissionAvailability> {
  return (await readCurrentReport(db, deviceId, provider, version)).availability;
}

/**
 * {@link readRuntimeReport} plus the identity hash of the current report (null unless it is
 * current): a cloud device's installed evidence names its report by it.
 */
export async function readCurrentReport(
  db: KernelSchemaDb,
  deviceId: string,
  provider: string,
  version: string | undefined,
): Promise<{
  availability: PermissionAvailability;
  identityHash: string | null;
  instanceGeneration: string | null;
}> {
  const unprobed = {
    availability: unprobedPermissionAvailability(),
    identityHash: null,
    instanceGeneration: null,
  };
  if (!version) return unprobed;
  const [device, instance] = await Promise.all([
    db.selectFrom("devices").select("source").where("id", "=", deviceId).executeTakeFirst(),
    db
      .selectFrom("device_instances")
      .select([
        "provider",
        "status",
        "handle",
        "created_at",
        "instance_limits",
        "permission_runtime_identity",
      ])
      .where("device_id", "=", deviceId)
      .executeTakeFirst(),
  ]);
  if (!instance || instance.provider !== provider || !instance.permission_runtime_identity)
    return unprobed;
  // A cloud instance attests only through the kernel-built identity its current row proves (B-15):
  // a changed provider version, handle, generation or applied limits is unprobed.
  if (device?.source === "cloud") {
    const current = currentCloudIdentity(instance, provider, version);
    if (!current || !sameRuntimeIdentity(current, instance.permission_runtime_identity))
      return unprobed;
  }
  // A local instance attests only through its installed post-commit binding (B4): an unbound or
  // still awaiting generation, or a report differing from the bound identity, is unprobed.
  if (provider === LOCAL_PROVIDER) {
    const binding = await db
      .selectFrom("device_instance_bindings")
      .select(["status", "runtime_identity"])
      .where("device_id", "=", deviceId)
      .where("instance_generation", "=", String(instance.created_at.getTime()))
      .executeTakeFirst();
    if (
      binding?.status !== "installed" ||
      !binding.runtime_identity ||
      !sameRuntimeIdentity(binding.runtime_identity, instance.permission_runtime_identity)
    )
      return unprobed;
  }
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
    return unprobed;
  const stored = cloudSupportOf(row.report);
  if (stored === null) return unprobed;
  const report =
    device?.source === "cloud" ? cloudEnforceable(stored, instance.instance_limits) : stored;
  // an instance-boundary provider is a supported device whose scope is the whole instance
  if (!report.restricted && report.boundary !== "instance" && !report.outsideSandbox)
    return {
      availability: {
        state: "unsupported",
        reason: report.unavailableReason ?? "This runtime cannot enforce permission operations",
      },
      identityHash: row.identity_hash,
      instanceGeneration: row.instance_generation,
    };
  return {
    availability: { state: "supported", report },
    identityHash: row.identity_hash,
    instanceGeneration: row.instance_generation,
  };
}

/**
 * Whether a cloud device's current instance owes a new runtime report (B-15): it can prove a
 * kernel-built identity (a live instance of this provider version with a handle and recorded
 * applied limits) but no current report is recorded for it. Database reads only.
 */
export async function cloudReportOwed(
  db: KernelSchemaDb,
  deviceId: string,
  provider: string,
  version: string | undefined,
): Promise<boolean> {
  if (!version) return false;
  const [device, instance] = await Promise.all([
    db.selectFrom("devices").select("source").where("id", "=", deviceId).executeTakeFirst(),
    db
      .selectFrom("device_instances")
      .select(["provider", "status", "handle", "created_at", "instance_limits"])
      .where("device_id", "=", deviceId)
      .executeTakeFirst(),
  ]);
  if (device?.source !== "cloud" || !instance) return false;
  if (!currentCloudIdentity(instance, provider, version)) return false;
  return (await readCurrentReport(db, deviceId, provider, version)).identityHash === null;
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

  /**
   * Records a cloud instance's permission support with its kernel-built identity
   * ({@link cloudRuntimeIdentity}, B-15), read from the committed row under the caller's device
   * authority writer lock: the lifecycle holder calls it after create (in the handle commit's
   * transaction) or after resume and limits changes, with the support it read from that exact
   * instance under its lease. A local device, an instance of another provider, one without a
   * handle or without recorded applied limits records nothing new (and clears a stale identity).
   */
  @Transactional({ propagation: "mandatory" })
  async recordCloud(
    deviceId: string,
    provider: string,
    version: string,
    report: SandboxPermissionSupport,
  ): Promise<void> {
    this.locks.assertHeld("device", deviceId, true);
    const device = await this.db
      .selectFrom("devices")
      .select("source")
      .where("id", "=", deviceId)
      .executeTakeFirst();
    if (device?.source !== "cloud") return;
    const instance = await this.db
      .selectFrom("device_instances")
      .select(["provider", "status", "handle", "created_at", "instance_limits"])
      .where("device_id", "=", deviceId)
      .executeTakeFirst();
    if (!instance || instance.provider !== provider) return;
    const identity = currentCloudIdentity(instance, provider, version);
    await this.record(deviceId, provider, version, identity ?? undefined, report);
  }

  /**
   * Clears a cloud instance's recorded identity (its report then reads unprobed). Caller holds
   * the device authority writer lock and has checked the instance it probed.
   */
  @Transactional({ propagation: "mandatory" })
  async clearCloud(deviceId: string, provider: string): Promise<void> {
    this.locks.assertHeld("device", deviceId, true);
    await this.db
      .updateTable("device_instances")
      .set({ permission_runtime_identity: null })
      .where("device_id", "=", deviceId)
      .where("provider", "=", provider)
      .execute();
  }
}
