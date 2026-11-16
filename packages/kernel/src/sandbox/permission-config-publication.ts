import { createHash } from "node:crypto";
import { SandboxScopeDeniedError, validateAllowHost } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { KernelConfig } from "../config/schema.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { CloudNetworkSettingSchema, invalidCloudNetwork } from "../orgs/cloud-network-setting.js";
import { coversHost, orgEffectiveHosts } from "./modes.js";
import { isExecutionMethod } from "./operation-authority-types.js";
import { needsFullCeiling, PermissionCeilingWrites } from "./permission-ceiling-writes.js";
import { readStoredDevicesAutoMode, resolveDevicesAutoMode } from "./platform-auto-mode.js";

const ProjectionSchema = z
  .object({
    autoMode: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("deployment-setting") }).strict(),
      z.object({ kind: z.literal("configured"), value: z.enum(["allowed", "off"]) }).strict(),
    ]),
    egress: z.enum(["none", "allowlist"]),
    orgHosts: z.enum(["extend", "within"]),
    allowHosts: z
      .array(
        z
          .string()
          .max(253)
          .refine((host) => validateAllowHost(host).length === 0),
      )
      .max(4096),
  })
  .strict();
export type PermissionConfigProjection = z.infer<typeof ProjectionSchema>;
/** Validated nonsecret winning config inputs; PG fallback is read separately under the writer lock. */
export function parsePermissionConfigProjection(input: unknown): PermissionConfigProjection {
  const parsed = ProjectionSchema.parse(input);
  const projection = {
    autoMode: parsed.autoMode,
    egress: parsed.egress,
    orgHosts: parsed.orgHosts,
    allowHosts: [...new Set(parsed.allowHosts)].sort(),
  };
  if (Buffer.byteLength(JSON.stringify(projection)) > 65536)
    throw new SandboxScopeDeniedError("Permission configuration projection exceeds 64 KiB");
  return projection;
}
export function permissionConfigProjection(config: KernelConfig): PermissionConfigProjection {
  const { egress, orgHosts, allowHosts } = config.sandbox.limits;
  return parsePermissionConfigProjection({
    autoMode:
      config.devices.autoMode === undefined
        ? { kind: "deployment-setting" }
        : { kind: "configured", value: config.devices.autoMode },
    egress,
    orgHosts,
    allowHosts,
  });
}
export function permissionProjectionFingerprint(projection: PermissionConfigProjection): string {
  return createHash("sha256")
    .update(JSON.stringify(parsePermissionConfigProjection(projection)))
    .digest("hex");
}
/** Only independent platform permission inputs, never resource sizing, secrets or resolved PG fallback. */
export function permissionConfigFingerprint(config: KernelConfig): string {
  return permissionProjectionFingerprint(permissionConfigProjection(config));
}
export type PermissionConfigInitialization =
  | { outcome: "initialized" | "matching" | "already-active" | "activated"; activeHash: string }
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
      this.validateStored(row);
      return row.fingerprint === candidateHash
        ? { outcome: "matching", activeHash: row.fingerprint }
        : { outcome: "mismatch", activeHash: row.fingerprint, candidateHash };
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
    return inserted.fingerprint === candidateHash
      ? { outcome: "initialized", activeHash: candidateHash }
      : { outcome: "mismatch", activeHash: inserted.fingerprint, candidateHash };
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
  private validateStored(row: {
    projection: unknown;
    fingerprint: string;
  }): PermissionConfigProjection {
    const parsed = parsePermissionConfigProjection(row.projection);
    if (permissionProjectionFingerprint(parsed) !== row.fingerprint)
      throw new SandboxScopeDeniedError(
        "Published permission projection does not match its fingerprint",
      );
    return parsed;
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
    const before = this.validateStored(row);
    if (row.fingerprint === fingerprint) return "matching";
    if (row.fingerprint !== previous)
      throw new PermissionConfigActivationConflict(row.fingerprint, fingerprint);
    const changed = await this.db
      .updateTable("permission_config_publication")
      .set({
        fingerprint,
        projection: JSON.stringify(next),
        updated_at: new Date(),
      })
      .where("id", "=", "platform")
      .where("fingerprint", "=", previous)
      .executeTakeFirstOrThrow();
    if (changed.numUpdatedRows !== 1n)
      throw new PermissionConfigActivationConflict(row.fingerprint, fingerprint);
    const stored = await readStoredDevicesAutoMode(this.db.db);
    const effective = (projection: PermissionConfigProjection) =>
      resolveDevicesAutoMode(
        projection.autoMode.kind === "configured" ? projection.autoMode.value : undefined,
        projection.autoMode.kind === "configured" ? "file" : undefined,
        stored,
      ).mode;
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
    const sources = new Map(devices.map((device) => [device.id, device.source]));
    if (before.egress !== next.egress)
      await this.ceilings.invalidateDeviceConsentUnderPlatform(
        devices.filter((device) => device.source === "cloud").map((device) => device.id),
      );
    await this.ceilings.publishLocked(
      {},
      "platform",
      (scope, row) => {
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
