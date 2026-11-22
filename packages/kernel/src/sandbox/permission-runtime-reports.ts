import { createHash } from "node:crypto";
import {
  instanceSupported,
  type SandboxHandle,
  type SandboxPermissionSupport,
} from "@capybara-hq/plugin-sdk";
import { parseSandboxPermissionSupport } from "@capybara-hq/plugin-sdk/device-protocol";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
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
 * The kernel-built runtime identity of a device's instance (B-15, Q1 option A; device-provider
 * spec §6.7), one rule for every provider. A provider is an in-process extension (full trust), so
 * its own permission support report, bound to these kernel facts, is the evidence: the provider
 * plugin and version (`runtimeHash`), the committed instance handle (`helperHash`), the recorded
 * applied limits with no provider-attested image digest and the device's stored report revision
 * (`imageFingerprint`), and the instance generation. Any of them changing (a new report revision
 * too) makes a recorded report unprobed until the lifecycle records it again.
 */
export function runtimeIdentityOf(input: {
  provider: string;
  version: string;
  handle: SandboxHandle;
  instanceGeneration: string;
  applied: AppliedLimits;
  /** `devices.report->>'revision'`; null while no report is stored. */
  reportRevision: string | null;
}): PermissionRuntimeIdentity {
  return {
    runtimeHash: sha256({
      kind: "device-provider",
      provider: input.provider,
      version: input.version,
    }),
    helperHash: sha256({ kind: "device-instance", handle: input.handle }),
    imageFingerprint: sha256({
      kind: "device-environment",
      applied: {
        mode: input.applied.mode,
        network: {
          kind: input.applied.network.kind,
          hosts: [...new Set(input.applied.network.hosts)].sort(),
        },
      },
      reportRevision: input.reportRevision,
      imageDigest: null,
    }),
    instanceGeneration: input.instanceGeneration,
  };
}

/**
 * A permission support report strictly parsed (`parseSandboxPermissionSupport`, version 2), or null
 * when it is not one: a provider's answer (an in-process extension is trusted, but its answer is
 * stored and read back later, so nothing beyond the contract's fields is kept) and a stored report
 * read back (one recorded before version 2 is no report).
 */
export function supportOf(value: unknown): SandboxPermissionSupport | null {
  try {
    return parseSandboxPermissionSupport(value);
  } catch {
    return null;
  }
}

/** The revision of the device's stored report (`devices.report`), or null when none is stored. */
async function storedReportRevision(db: KernelSchemaDb, deviceId: string): Promise<string | null> {
  const row = await db
    .selectFrom("devices")
    .select(sql<string | null>`report->>'revision'`.as("revision"))
    .where("id", "=", deviceId)
    .executeTakeFirst();
  return row?.revision ?? null;
}

/**
 * The identity the instance row proves now, or null when it proves none: no live instance of this
 * provider, no handle or no recorded applied limits.
 */
function currentIdentity(
  instance: {
    provider: string | null;
    status: string;
    handle: SandboxHandle | null;
    created_at: Date;
    instance_limits: unknown;
  },
  provider: string,
  version: string,
  reportRevision: string | null,
): PermissionRuntimeIdentity | null {
  const applied = readInstanceLimits(instance.instance_limits).applied;
  if (
    instance.provider !== provider ||
    !instance.handle ||
    applied === null ||
    (instance.status !== "running" && instance.status !== "suspended")
  )
    return null;
  return runtimeIdentityOf({
    provider,
    version,
    handle: instance.handle,
    instanceGeneration: String(instance.created_at.getTime()),
    applied,
    reportRevision,
  });
}

/**
 * What an instance can enforce of its provider's report (B-12, spec §124): running outside the
 * sandbox needs the instance applied in the `auto` tier (the platform and the org allowing it when
 * it was made). An instance applied in the OS sandbox tier holds its outer network only through
 * the restricted child filters that an escalated call leaves, so outside-sandbox reads as
 * unsupported there whatever the provider reports; restricted support stands.
 */
export function enforceable(
  report: SandboxPermissionSupport,
  instanceLimits: unknown,
): SandboxPermissionSupport {
  if (!report.outsideSandbox || readInstanceLimits(instanceLimits).applied?.mode === "auto")
    return report;
  return {
    ...report,
    outsideSandbox: false,
    unavailableReason:
      "This instance enforces its outer network only inside the OS sandbox, so it cannot run a command outside it",
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
 * current, which names the installed evidence) and the support it recorded (null unless it is
 * current), whatever availability that support gives.
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
  support: SandboxPermissionSupport | null;
}> {
  const unprobed = {
    availability: unprobedPermissionAvailability(),
    identityHash: null,
    instanceGeneration: null,
    support: null,
  };
  if (!version) return unprobed;
  const [revision, instance] = await Promise.all([
    storedReportRevision(db, deviceId),
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
  // an instance attests only through the kernel-built identity its current row proves (B-15): a
  // changed provider version, handle, generation, applied limits or report revision is unprobed
  const current = currentIdentity(instance, provider, version, revision);
  if (!current || !sameRuntimeIdentity(current, instance.permission_runtime_identity))
    return unprobed;
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
  const stored = supportOf(row.report);
  if (stored === null) return unprobed;
  const report = enforceable(stored, instance.instance_limits);
  const evidence = {
    identityHash: row.identity_hash,
    instanceGeneration: row.instance_generation,
    support: report,
  };
  // an instance-boundary provider is a supported device whose scope is the whole instance,
  // unless its report names why it is unavailable (a stale image, a digest mismatch)
  if (!report.restricted && !instanceSupported(report) && !report.outsideSandbox)
    return {
      availability: {
        state: "unsupported",
        reason: report.unavailableReason ?? "This runtime cannot enforce permission operations",
        cause: { kind: "runtime" },
      },
      ...evidence,
    };
  return { availability: { state: "supported", report }, ...evidence };
}

/**
 * Whether a device's current instance owes a new runtime report (B-15): it can prove a
 * kernel-built identity (a live instance of this provider version with a handle and recorded
 * applied limits) but no current report is recorded for it (none yet, or one recorded under an
 * earlier report revision). Database reads only.
 */
export async function reportOwed(
  db: KernelSchemaDb,
  deviceId: string,
  provider: string,
  version: string | undefined,
): Promise<boolean> {
  if (!version) return false;
  const [revision, instance] = await Promise.all([
    storedReportRevision(db, deviceId),
    db
      .selectFrom("device_instances")
      .select(["provider", "status", "handle", "created_at", "instance_limits"])
      .where("device_id", "=", deviceId)
      .executeTakeFirst(),
  ]);
  if (!instance) return false;
  if (!currentIdentity(instance, provider, version, revision)) return false;
  return (await readCurrentReport(db, deviceId, provider, version)).identityHash === null;
}
@Injectable()
export class PermissionRuntimeReports {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(PermissionAuthorityLock) private readonly locks: PermissionAuthorityLock,
  ) {}

  /**
   * Records an instance's permission support with its kernel-built identity
   * ({@link runtimeIdentityOf}, B-15), read from the committed row under the caller's device
   * authority writer lock: the lifecycle holder calls it after create (in the handle commit's
   * transaction) or after resume and limits changes, with the support it read from that exact
   * instance under its lease. An instance of another provider records nothing; one without a
   * handle or without recorded applied limits records nothing new and clears a stale identity.
   * The support recorded is also stored with the device's report (`devices.report.support`), so
   * the stored support never lags what the runtime last said: the caller holds the device row
   * lock (taken before the authority writer lock, the device writers' order).
   */
  @Transactional({ propagation: "mandatory" })
  async recordSupport(
    deviceId: string,
    provider: string,
    version: string,
    report: SandboxPermissionSupport,
  ): Promise<void> {
    this.locks.assertHeld("device", deviceId, true);
    const [revision, instance] = await Promise.all([
      storedReportRevision(this.db.db, deviceId),
      this.db
        .selectFrom("device_instances")
        .select(["provider", "status", "handle", "created_at", "instance_limits"])
        .where("device_id", "=", deviceId)
        .executeTakeFirst(),
    ]);
    if (!instance || instance.provider !== provider) return;
    const identity = currentIdentity(instance, provider, version, revision);
    if (!identity) {
      await this.db
        .updateTable("device_instances")
        .set({ permission_runtime_identity: null })
        .where("device_id", "=", deviceId)
        .execute();
      return;
    }
    const checked = runtimeIdentity(identity);
    await this.db
      .updateTable("device_instances")
      .set({ permission_runtime_identity: JSON.stringify(checked) })
      .where("device_id", "=", deviceId)
      .execute();
    const values = {
      provider,
      provider_version: version,
      instance_generation: checked.instanceGeneration,
      identity_hash: permissionScopeHash(checked),
      report: JSON.stringify(report),
    };
    await this.db
      .insertInto("device_permission_reports")
      .values({ device_id: deviceId, ...values })
      .onConflict((oc) =>
        oc.column("device_id").doUpdateSet({ ...values, observed_at: new Date() }),
      )
      .execute();
    await this.db
      .updateTable("devices")
      .set({
        report: sql`COALESCE(report, '{}'::jsonb) || jsonb_build_object('support', ${JSON.stringify(report)}::jsonb)`,
      })
      .where("id", "=", deviceId)
      .execute();
  }

  /**
   * Clears an instance's recorded identity (its report then reads unprobed). Caller holds the
   * device authority writer lock and has checked the instance it probed.
   */
  @Transactional({ propagation: "mandatory" })
  async clearSupport(deviceId: string, provider: string): Promise<void> {
    this.locks.assertHeld("device", deviceId, true);
    await this.db
      .updateTable("device_instances")
      .set({ permission_runtime_identity: null })
      .where("device_id", "=", deviceId)
      .where("provider", "=", provider)
      .execute();
  }
}
