import { createHash } from "node:crypto";
import { SandboxScopeDeniedError, validateAllowHost } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { z } from "zod";
import type { KernelConfig } from "../config/schema.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { CloudNetworkSettingSchema, invalidCloudNetwork } from "../orgs/cloud-network-setting.js";
import { coversHost, orgEffectiveHosts } from "./modes.js";
import { isExecutionMethod } from "./operation-authority-types.js";
import {
  localMachineRoots,
  needsFullCeiling,
  needsWiderDeviceCeiling,
  PermissionCeilingWrites,
} from "./permission-ceiling-writes.js";
import {
  convertStoredPermissionKeys,
  readStoredDevicesFullAccess,
  resolveDevicesFullAccess,
} from "./platform-full-access.js";

const FullAccessSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("deployment-setting") }).strict(),
  z.object({ kind: z.literal("configured"), value: z.enum(["allowed", "off"]) }).strict(),
]);
const AllowHosts = z
  .array(
    z
      .string()
      .max(253)
      .refine((host) => validateAllowHost(host).length === 0),
  )
  .max(4096);
const ProjectionSchema = z
  .object({
    version: z.literal(2),
    fullAccess: FullAccessSource,
    egress: z.enum(["none", "allowlist"]),
    orgHosts: z.enum(["extend", "within"]),
    allowHosts: AllowHosts,
  })
  .strict();
/**
 * The 6c projection released replicas published (version 1, no version field). It is read only to
 * convert it (B1): validated with its own canonical algorithm and exact fingerprint, never
 * published again.
 */
const LegacyProjectionSchema = z
  .object({
    autoMode: FullAccessSource,
    egress: z.enum(["none", "allowlist"]),
    orgHosts: z.enum(["extend", "within"]),
    allowHosts: AllowHosts,
  })
  .strict();
export type PermissionConfigProjection = z.infer<typeof ProjectionSchema>;
type LegacyPermissionConfigProjection = z.infer<typeof LegacyProjectionSchema>;
const bounded = <T>(projection: T): T => {
  if (Buffer.byteLength(JSON.stringify(projection)) > 65536)
    throw new SandboxScopeDeniedError("Permission configuration projection exceeds 64 KiB");
  return projection;
};
/** Validated nonsecret winning config inputs; PG fallback is read separately under the writer lock. */
export function parsePermissionConfigProjection(input: unknown): PermissionConfigProjection {
  const parsed = ProjectionSchema.parse(input);
  // the fixed property order is the canonical form the fingerprint hashes
  return bounded({
    version: 2,
    fullAccess: parsed.fullAccess,
    egress: parsed.egress,
    orgHosts: parsed.orgHosts,
    allowHosts: [...new Set(parsed.allowHosts)].sort(),
  });
}
function parseLegacyProjection(input: unknown): LegacyPermissionConfigProjection {
  const parsed = LegacyProjectionSchema.parse(input);
  return bounded({
    autoMode: parsed.autoMode,
    egress: parsed.egress,
    orgHosts: parsed.orgHosts,
    allowHosts: [...new Set(parsed.allowHosts)].sort(),
  });
}
/** The version 2 projection that says exactly what a version 1 projection said. */
const ofLegacy = (p: LegacyPermissionConfigProjection): PermissionConfigProjection => ({
  version: 2,
  fullAccess: p.autoMode,
  egress: p.egress,
  orgHosts: p.orgHosts,
  allowHosts: p.allowHosts,
});
export function permissionConfigProjection(config: KernelConfig): PermissionConfigProjection {
  const { egress, orgHosts, allowHosts } = config.sandbox.limits;
  return parsePermissionConfigProjection({
    version: 2,
    fullAccess:
      config.devices.fullAccess === undefined
        ? { kind: "deployment-setting" }
        : { kind: "configured", value: config.devices.fullAccess },
    egress,
    orgHosts,
    allowHosts,
  });
}
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function permissionProjectionFingerprint(projection: PermissionConfigProjection): string {
  return sha256(parsePermissionConfigProjection(projection));
}
/** Only independent platform permission inputs, never resource sizing, secrets or resolved PG fallback. */
export function permissionConfigFingerprint(config: KernelConfig): string {
  return permissionProjectionFingerprint(permissionConfigProjection(config));
}
/** A validated stored publication: its semantics as version 2, and whether it still is version 1. */
interface StoredPublication {
  fingerprint: string;
  projection: PermissionConfigProjection;
  legacy: boolean;
}
export type PermissionConfigInitialization =
  | {
      outcome: "initialized" | "matching" | "already-active" | "activated" | "migrated";
      activeHash: string;
    }
  | { outcome: "mismatch"; activeHash: string; candidateHash: string };
export interface PermissionConfigInitializeOptions {
  activation?: Readonly<{ expectedActiveHash: string }>;
  startup?: { signal: AbortSignal; remainingMs: () => number };
}
export function validatePermissionConfigActivation(activation: unknown): void {
  if (activation === undefined) return;
  if (
    activation === null ||
    typeof activation !== "object" ||
    !("expectedActiveHash" in activation) ||
    typeof activation.expectedActiveHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(activation.expectedActiveHash)
  )
    throw new Error("Permission configuration activation requires a lowercase 64-hex active hash");
}
export class PermissionConfigActivationConflict extends Error {
  constructor(activeHash: string | undefined, candidateHash: string) {
    super(
      activeHash === undefined
        ? "Permission configuration is not initialized; run the first startup normally without --activate-permission-config"
        : `Permission configuration differs from the active deployment configuration. active=${activeHash}; candidate=${candidateHash}. To intentionally activate this resolved startup configuration, run: capybara start --activate-permission-config ${activeHash}`,
    );
    this.name = "PermissionConfigActivationConflict";
  }
}
@Injectable()
export class PermissionConfigPublication {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(PermissionCeilingWrites) private readonly ceilings: PermissionCeilingWrites,
    @Optional() @Inject(KERNEL_LOGGER) private readonly log?: Pick<KernelLogger, "warn">,
  ) {}
  /** Capture the actual validated startup projection once, before waiting for authority. */
  async initialize(
    options: PermissionConfigInitializeOptions = {},
  ): Promise<PermissionConfigInitialization> {
    validatePermissionConfigActivation(options.activation);
    const projection = permissionConfigProjection(this.config.get());
    const initialize = () => this.initializeLocked(projection, options.activation);
    if (options.startup) {
      const { url, connectTimeoutMs } = this.config.get().db;
      return this.txHost.runStartupActivation(initialize, {
        connectionString: url,
        connectTimeoutMs,
        ...options.startup,
      });
    }
    return this.txHost.run(initialize, { propagation: "requires_new" });
  }
  @Transactional({ propagation: "mandatory" })
  private async initializeLocked(
    projection: PermissionConfigProjection,
    activation?: Readonly<{ expectedActiveHash: string }>,
  ): Promise<PermissionConfigInitialization> {
    await this.ceilings.lock({}, "platform");
    const candidateHash = permissionProjectionFingerprint(projection);
    const row = await this.db
      .selectFrom("permission_config_publication")
      .select(["fingerprint", "projection"])
      .where("id", "=", "platform")
      .executeTakeFirst();
    if (activation) {
      if (!row) throw new PermissionConfigActivationConflict(undefined, candidateHash);
      const outcome = await this.publishLocked(activation.expectedActiveHash, projection);
      return {
        outcome: outcome === "matching" ? "already-active" : "activated",
        activeHash: candidateHash,
      };
    }
    if (row) {
      const stored = this.validateStored(row);
      if (row.fingerprint === candidateHash)
        return { outcome: "matching", activeHash: candidateHash };
      // B1: a released version 1 publication that says exactly what this replica says converts
      // in place (format only: no epoch, no Full reset, no revocation)
      if (stored.legacy && permissionProjectionFingerprint(stored.projection) === candidateHash) {
        await this.replaceLocked(row.fingerprint, projection);
        await convertStoredPermissionKeys(this.db.db, this.log);
        return { outcome: "migrated", activeHash: candidateHash };
      }
      return { outcome: "mismatch", activeHash: row.fingerprint, candidateHash };
    }
    await this.db
      .insertInto("permission_config_publication")
      .values({
        id: "platform",
        fingerprint: candidateHash,
        projection: JSON.stringify(projection),
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    const inserted = await this.db
      .selectFrom("permission_config_publication")
      .select("fingerprint")
      .where("id", "=", "platform")
      .executeTakeFirstOrThrow();
    if (inserted.fingerprint !== candidateHash)
      return { outcome: "mismatch", activeHash: inserted.fingerprint, candidateHash };
    await convertStoredPermissionKeys(this.db.db, this.log);
    return { outcome: "initialized", activeHash: candidateHash };
  }
  /** CAS publication precedes exposing the new local config. Same-next replicas converge idempotently. */
  @Transactional({ propagation: "requires_new" })
  async publish(before: KernelConfig, next: KernelConfig): Promise<void> {
    await this.ceilings.lock({}, "platform");
    try {
      await this.publishLocked(
        permissionConfigFingerprint(before),
        permissionConfigProjection(next),
      );
    } catch (error) {
      if (error instanceof PermissionConfigActivationConflict)
        throw new SandboxScopeDeniedError(
          "Permission configuration changed on another replica; wait for its current source revision",
        );
      throw error;
    }
  }
  /** Validates the stored publication with the algorithm of its own version. */
  private validateStored(row: { projection: unknown; fingerprint: string }): StoredPublication {
    const corrupt = () =>
      new SandboxScopeDeniedError("Published permission projection does not match its fingerprint");
    const raw = row.projection;
    if (raw !== null && typeof raw === "object" && "version" in raw) {
      const projection = parsePermissionConfigProjection(raw);
      if (permissionProjectionFingerprint(projection) !== row.fingerprint) throw corrupt();
      return { fingerprint: row.fingerprint, projection, legacy: false };
    }
    const legacy = parseLegacyProjection(raw);
    if (sha256(legacy) !== row.fingerprint) throw corrupt();
    return { fingerprint: row.fingerprint, projection: ofLegacy(legacy), legacy: true };
  }
  /** Compare-and-set of the publication row; the caller holds the platform write lock. */
  @Transactional({ propagation: "mandatory" })
  private async replaceLocked(previous: string, next: PermissionConfigProjection): Promise<void> {
    const fingerprint = permissionProjectionFingerprint(next);
    const changed = await this.db
      .updateTable("permission_config_publication")
      .set({ fingerprint, projection: JSON.stringify(next), updated_at: new Date() })
      .where("id", "=", "platform")
      .where("fingerprint", "=", previous)
      .executeTakeFirstOrThrow();
    if (changed.numUpdatedRows !== 1n)
      throw new PermissionConfigActivationConflict(previous, fingerprint);
  }
  @Transactional({ propagation: "mandatory" })
  private async publishLocked(
    previous: string,
    next: PermissionConfigProjection,
  ): Promise<"matching" | "activated"> {
    const fingerprint = permissionProjectionFingerprint(next);
    const row = await this.db
      .selectFrom("permission_config_publication")
      .select(["fingerprint", "projection"])
      .where("id", "=", "platform")
      .executeTakeFirst();
    if (!row) throw new PermissionConfigActivationConflict(undefined, fingerprint);
    const stored = this.validateStored(row);
    const before = stored.projection;
    if (row.fingerprint === fingerprint) return "matching";
    if (row.fingerprint !== previous)
      throw new PermissionConfigActivationConflict(row.fingerprint, fingerprint);
    await this.replaceLocked(previous, next);
    // a version 1 predecessor converts its stored keys in this same transaction (B1)
    if (stored.legacy) await convertStoredPermissionKeys(this.db.db, this.log);
    // format only: the same semantics publish the new fingerprint (the barrier) and nothing else
    if (permissionProjectionFingerprint(before) === fingerprint) return "activated";
    const storedChoice = await readStoredDevicesFullAccess(this.db.db, this.log);
    const effective = (projection: PermissionConfigProjection) =>
      resolveDevicesFullAccess(
        projection.fullAccess.kind === "configured" ? projection.fullAccess.value : undefined,
        projection.fullAccess.kind === "configured" ? "file" : undefined,
        storedChoice,
      ).permission;
    const beforeMode = effective(before),
      nextMode = effective(next);
    const orgs = await this.db.selectFrom("orgs").select(["id", "settings"]).execute();
    const settings = new Map(
      orgs.map((org) => {
        const raw = (org.settings as { cloudNetwork?: unknown } | null)?.cloudNetwork;
        const parsed = CloudNetworkSettingSchema.safeParse(raw);
        return [
          org.id,
          raw === undefined ? undefined : parsed.success ? parsed.data : invalidCloudNetwork(),
        ] as const;
      }),
    );
    const devices = await this.db.selectFrom("devices").select(["id", "source"]).execute();
    const machineRoots = await localMachineRoots(this.db.db);
    const sources = new Map(devices.map((device) => [device.id, device.source]));
    if (before.egress !== next.egress)
      await this.ceilings.invalidateDeviceConsentUnderPlatform(
        devices.filter((device) => device.source === "cloud").map((device) => device.id),
      );
    await this.ceilings.publishLocked(
      {},
      "platform",
      (scope, row) => {
        // Full off also narrows restricted reach to the workspace (B2): running restricted work
        // outside a machine's roots goes with Full work, as the owner writer decides
        if (nextMode === "off" && needsWiderDeviceCeiling(scope, machineRoots.get(row.device_id)))
          return true;
        if (needsFullCeiling(scope))
          return (
            nextMode === "off" ||
            (sources.get(row.device_id) === "cloud" &&
              before.egress !== "none" &&
              next.egress === "none")
          );
        if (
          !isExecutionMethod(row.method) ||
          !("network" in scope) ||
          scope.network.kind !== "allowlist"
        )
          return false;
        const hosts = orgEffectiveHosts(next, settings.get(row.org_id));
        return scope.network.hosts.some(
          (host) =>
            !hosts.some((pattern) => coversHost(pattern, host)) &&
            !(
              next.egress !== "none" &&
              next.orgHosts !== "within" &&
              row.granted_hosts.includes(host)
            ),
        );
      },
      beforeMode !== nextMode,
    );
    return "activated";
  }
  async assertCurrent(): Promise<void> {
    const row = await this.db
      .selectFrom("permission_config_publication")
      .select("fingerprint")
      .where("id", "=", "platform")
      .executeTakeFirst();
    if (!row || row.fingerprint !== permissionConfigFingerprint(this.config.get()))
      throw new SandboxScopeDeniedError(
        "This replica has not applied the current permission configuration",
      );
  }
}
