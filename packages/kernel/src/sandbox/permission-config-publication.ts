import { createHash } from "node:crypto";
import { SandboxScopeDeniedError, validateAllowHost } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { sql } from "kysely";
import { z } from "zod";
import type { KernelConfig } from "../config/schema.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { hostGrantable, hostGrantCeiling } from "./device-sandbox.js";
import {
  type ConfiguredDeviceSandbox,
  convertStoredPermissionKeys,
  lockOrgsWithStoredPermissionKeys,
  orgDeviceSandboxOf,
  readStoredDeviceSandbox,
  resolveDeviceSandboxSettings,
} from "./device-sandbox-settings.js";
import {
  cloudChosenMode,
  coversHost,
  type DeploymentDevicePolicy,
  effectiveDevicePolicy,
  orgEffectiveHosts,
} from "./modes.js";
import {
  cloudDevicesFollowingDefault,
  hostsNarrowed,
  localMachineRoots,
  needsFullCeiling,
  needsOpenNetwork,
  needsWiderDeviceCeiling,
  PermissionCeilingWrites,
} from "./permission-ceiling-writes.js";

/** Whether a field comes from the startup config (with its value) or the deployment setting. */
const SettingSource = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("deployment-setting") }).strict(),
    z.object({ kind: z.literal("configured"), value }).strict(),
  ]);
const PermissionSource = SettingSource(z.enum(["allowed", "off"]));
const NetworkSource = SettingSource(z.enum(["open", "allowlist"]));
type PermissionSourceValue = z.infer<typeof PermissionSource>;
const AllowHosts = z
  .array(
    z
      .string()
      .max(253)
      .refine((host) => validateAllowHost(host).length === 0),
  )
  .max(4096);
/**
 * The current projection (version 3, approval-only profiles design): the platform's device sandbox
 * inputs (`devices.outsideSandbox`, `devices.network.default` / `ceiling`) and the network limits.
 */
const ProjectionSchema = z
  .object({
    version: z.literal(3),
    outsideSandbox: PermissionSource,
    network: z.object({ default: NetworkSource, ceiling: NetworkSource }).strict(),
    egress: z.enum(["none", "allowlist"]),
    orgHosts: z.enum(["extend", "within"]),
    allowHosts: AllowHosts,
  })
  .strict();
/**
 * The B1 projection released replicas published (version 2, `fullAccess`). It is read only to
 * convert it: validated with its own canonical algorithm and exact fingerprint, never published
 * again.
 */
const V2ProjectionSchema = z
  .object({
    version: z.literal(2),
    fullAccess: PermissionSource,
    egress: z.enum(["none", "allowlist"]),
    orgHosts: z.enum(["extend", "within"]),
    allowHosts: AllowHosts,
  })
  .strict();
/** The 6c projection (version 1, no version field), read only to convert it like version 2. */
const V1ProjectionSchema = z
  .object({
    autoMode: PermissionSource,
    egress: z.enum(["none", "allowlist"]),
    orgHosts: z.enum(["extend", "within"]),
    allowHosts: AllowHosts,
  })
  .strict();
export type PermissionConfigProjection = z.infer<typeof ProjectionSchema>;
type V2Projection = z.infer<typeof V2ProjectionSchema>;
type V1Projection = z.infer<typeof V1ProjectionSchema>;
const bounded = <T>(projection: T): T => {
  if (Buffer.byteLength(JSON.stringify(projection)) > 65536)
    throw new SandboxScopeDeniedError("Permission configuration projection exceeds 64 KiB");
  return projection;
};
const sortedHosts = (hosts: readonly string[]) => [...new Set(hosts)].sort();
/** Validated nonsecret winning config inputs; PG fallback is read separately under the writer lock. */
export function parsePermissionConfigProjection(input: unknown): PermissionConfigProjection {
  const parsed = ProjectionSchema.parse(input);
  // the fixed property order is the canonical form the fingerprint hashes
  return bounded({
    version: 3,
    outsideSandbox: parsed.outsideSandbox,
    network: { default: parsed.network.default, ceiling: parsed.network.ceiling },
    egress: parsed.egress,
    orgHosts: parsed.orgHosts,
    allowHosts: sortedHosts(parsed.allowHosts),
  });
}
function parseV2Projection(input: unknown): V2Projection {
  const parsed = V2ProjectionSchema.parse(input);
  return bounded({
    version: 2,
    fullAccess: parsed.fullAccess,
    egress: parsed.egress,
    orgHosts: parsed.orgHosts,
    allowHosts: sortedHosts(parsed.allowHosts),
  });
}
function parseV1Projection(input: unknown): V1Projection {
  const parsed = V1ProjectionSchema.parse(input);
  return bounded({
    autoMode: parsed.autoMode,
    egress: parsed.egress,
    orgHosts: parsed.orgHosts,
    allowHosts: sortedHosts(parsed.allowHosts),
  });
}
/**
 * The version 3 projection that says exactly what an old one said, as `capybara config
 * migrate-permissions` converts the config: the same outside-sandbox source, and a configured
 * `off` also a configured allowlist network ceiling (an old off kept every device on the
 * allowlist; never wider).
 */
const ofOld = (
  permission: PermissionSourceValue,
  p: Pick<V2Projection, "egress" | "orgHosts" | "allowHosts">,
): PermissionConfigProjection => ({
  version: 3,
  outsideSandbox: permission,
  network: {
    default: { kind: "deployment-setting" },
    ceiling:
      permission.kind === "configured" && permission.value === "off"
        ? { kind: "configured", value: "allowlist" }
        : { kind: "deployment-setting" },
  },
  egress: p.egress,
  orgHosts: p.orgHosts,
  allowHosts: p.allowHosts,
});
export function permissionConfigProjection(config: KernelConfig): PermissionConfigProjection {
  const { egress, orgHosts, allowHosts } = config.sandbox.limits;
  const source = <T extends string>(value: T | undefined) =>
    value === undefined
      ? ({ kind: "deployment-setting" } as const)
      : ({ kind: "configured", value } as const);
  return parsePermissionConfigProjection({
    version: 3,
    outsideSandbox: source(config.devices.outsideSandbox),
    network: {
      default: source(config.devices.network.default),
      ceiling: source(config.devices.network.ceiling),
    },
    egress,
    orgHosts,
    allowHosts,
  });
}
/** A configured value of the projection, or undefined when the deployment setting decides. */
const configuredOf = <T>(s: { kind: "deployment-setting" } | { kind: "configured"; value: T }) =>
  s.kind === "configured" ? s.value : undefined;
/** The projection as the settings reader's startup config input. */
const configuredView = (projection: PermissionConfigProjection): ConfiguredDeviceSandbox => {
  const fileSource = (s: { kind: string }) => (s.kind === "configured" ? "file" : undefined);
  return {
    outsideSandbox: configuredOf(projection.outsideSandbox),
    networkDefault: configuredOf(projection.network.default),
    networkCeiling: configuredOf(projection.network.ceiling),
    sources: {
      outsideSandbox: fileSource(projection.outsideSandbox),
      networkDefault: fileSource(projection.network.default),
      networkCeiling: fileSource(projection.network.ceiling),
    },
  } as const;
};
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function permissionProjectionFingerprint(projection: PermissionConfigProjection): string {
  return sha256(parsePermissionConfigProjection(projection));
}
/** Only independent platform permission inputs, never resource sizing, secrets or resolved PG fallback. */
export function permissionConfigFingerprint(config: KernelConfig): string {
  return permissionProjectionFingerprint(permissionConfigProjection(config));
}
/** A validated stored publication: its semantics as version 3, and whether it is an older version. */
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
    // the org rows a key conversion writes, before the platform lock (org row -> permission locks)
    await lockOrgsWithStoredPermissionKeys(this.db.db);
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
      // a released older publication that says exactly what this replica says converts in place
      // (format only: no epoch, no Full reset, no revocation)
      if (stored.legacy && permissionProjectionFingerprint(stored.projection) === candidateHash) {
        await this.replaceLocked(row.fingerprint, projection);
        await this.convertLocked(projection, true);
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
    await this.convertLocked(projection, true);
    return { outcome: "initialized", activeHash: candidateHash };
  }
  /** CAS publication precedes exposing the new local config. Same-next replicas converge idempotently. */
  @Transactional({ propagation: "requires_new" })
  async publish(before: KernelConfig, next: KernelConfig): Promise<void> {
    await lockOrgsWithStoredPermissionKeys(this.db.db);
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
    const version =
      raw !== null && typeof raw === "object" && "version" in raw ? raw.version : undefined;
    if (version === 3) {
      const projection = parsePermissionConfigProjection(raw);
      if (permissionProjectionFingerprint(projection) !== row.fingerprint) throw corrupt();
      return { fingerprint: row.fingerprint, projection, legacy: false };
    }
    if (version === 2) {
      const old = parseV2Projection(raw);
      if (sha256(old) !== row.fingerprint) throw corrupt();
      return { fingerprint: row.fingerprint, projection: ofOld(old.fullAccess, old), legacy: true };
    }
    if (version !== undefined) throw corrupt();
    const old = parseV1Projection(raw);
    if (sha256(old) !== row.fingerprint) throw corrupt();
    return { fingerprint: row.fingerprint, projection: ofOld(old.autoMode, old), legacy: true };
  }
  /**
   * Converts the stored permission keys ({@link convertStoredPermissionKeys}) and, when the
   * predecessor is an older publication (`pinDevices`), keeps every cloud device that ran on an
   * allowlist on it: a device still following its org (`network_mode` NULL) whose old effective
   * network was the allowlist (`sandbox.limits.orgHosts: within`, an org allowlist or an old off)
   * gets `network_mode = 'allowlist'` with no hosts of its own (it follows its org's hosts), so
   * the new model, where `orgHosts` limits hosts only, never opens it. The caller holds the
   * platform write lock and the org rows.
   */
  @Transactional({ propagation: "mandatory" })
  private async convertLocked(
    projection: PermissionConfigProjection,
    pinDevices: boolean,
  ): Promise<void> {
    const configuredCeiling = configuredOf(projection.network.ceiling);
    // a B1 snapshot an older replica wrote after migration 0167 becomes the device's own network
    // at every activation, before anything reads it (as 0165 and 0167 copy it: never wider)
    await copyCloudSnapshotNetworks(this.db.db);
    if (pinDevices) {
      const stored = await readStoredDeviceSandbox(this.db.db, this.log, configuredCeiling);
      const view = resolveDeviceSandboxSettings(configuredView(projection), stored);
      const deployment: DeploymentDevicePolicy = {
        fullAccess: view.outsideSandbox.permission,
        limits: {
          egress: projection.egress,
          orgHosts: projection.orgHosts,
          allowHosts: projection.allowHosts,
        },
      };
      const devices = await this.db
        .selectFrom("devices")
        .select(["id", "org_id", "mode", "owner_full_access", "outer_network"])
        .where("source", "=", "cloud")
        .where("network_mode", "is", null)
        .where("deleted_at", "is", null)
        .orderBy("id")
        .execute();
      const orgIds = [...new Set(devices.map((d) => d.org_id))];
      const orgSettings = new Map(
        orgIds.length === 0
          ? []
          : (
              await this.db
                .selectFrom("orgs")
                .select(["id", "settings"])
                .where("id", "in", orgIds)
                .execute()
            ).map((o) => [o.id, o.settings] as const),
      );
      const pinned = devices
        .filter(
          (d) =>
            effectiveDevicePolicy(
              deployment,
              orgDeviceSandboxOf(orgSettings.get(d.org_id)),
              cloudChosenMode(d),
              d.outer_network,
            ).network.kind === "allowlist",
        )
        .map((d) => d.id);
      if (pinned.length > 0)
        await this.db
          .updateTable("devices")
          .set({ network_mode: "allowlist", network_hosts: "[]" })
          .where("id", "in", pinned)
          .where("network_mode", "is", null)
          .execute();
    }
    await convertStoredPermissionKeys(this.db.db, this.log, { configuredCeiling });
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
    // the stored keys convert at every publication (old keys an old replica wrote meanwhile
    // too); an older predecessor also pins its cloud devices, in this same transaction
    await this.convertLocked(next, stored.legacy);
    // format only: the same semantics publish the new fingerprint (the barrier) and nothing else
    if (permissionProjectionFingerprint(before) === fingerprint) return "activated";
    const storedChoice = await readStoredDeviceSandbox(
      this.db.db,
      this.log,
      configuredOf(next.network.ceiling),
    );
    const effective = (projection: PermissionConfigProjection) =>
      resolveDeviceSandboxSettings(configuredView(projection), storedChoice);
    const beforeView = effective(before),
      nextView = effective(next);
    const beforeMode = beforeView.outsideSandbox.permission,
      nextMode = nextView.outsideSandbox.permission;
    // a network opened anywhere is a widening: consent given under the narrower network resets
    const networkWidened =
      (beforeView.network.ceiling === "allowlist" && nextView.network.ceiling === "open") ||
      (beforeView.network.default === "allowlist" && nextView.network.default === "open");
    const orgs = await this.db.selectFrom("orgs").select(["id", "settings"]).execute();
    const settings = new Map(
      orgs.map((org) => [org.id, orgDeviceSandboxOf(org.settings).deviceNetwork] as const),
    );
    const devices = await this.db.selectFrom("devices").select(["id", "source"]).execute();
    const machineRoots = await localMachineRoots(this.db.db);
    const sources = new Map(devices.map((device) => [device.id, device.source]));
    // the kill switch lifted is a widening for every cloud device (closing it only narrows)
    if (before.egress === "none" && next.egress !== "none")
      await this.ceilings.invalidateDeviceConsentUnderPlatform(
        devices.filter((device) => device.source === "cloud").map((device) => device.id),
      );
    // a network ceiling narrowed to the allowlist, or closed by the kill switch, takes running
    // open-network work
    const networkNarrowed =
      (beforeView.network.ceiling === "open" && nextView.network.ceiling === "allowlist") ||
      (before.egress !== "none" && next.egress === "none");
    // a default narrowed to the allowlist takes it from the cloud devices following it
    const following =
      !networkNarrowed &&
      beforeView.network.default === "open" &&
      nextView.network.default === "allowlist"
        ? new Set(
            [...(await cloudDevicesFollowingDefault(this.db.db))]
              .filter(([, org]) => settings.get(org)?.default === undefined)
              .map(([id]) => id),
          )
        : null;
    // the per-call host list widened: hosts the platform list did not cover, or orgs allowed
    // beyond it again (`within` to `extend`)
    const hostsWidened =
      (before.orgHosts === "within" && next.orgHosts === "extend") ||
      next.allowHosts.some(
        (h) => !before.allowHosts.some((p) => coversHost(p.toLowerCase(), h.toLowerCase())),
      );
    const grantable = (orgId: string, host: string) => {
      const org = settings.get(orgId);
      const ceiling =
        nextView.network.ceiling === "allowlist" || org?.ceiling === "allowlist"
          ? "allowlist"
          : "open";
      return hostGrantable(
        hostGrantCeiling(
          { boundary: "operation", networkMode: "allowlist", networkCeiling: ceiling },
          next,
          org === undefined ? {} : { deviceNetwork: org },
          null,
        ),
        host,
      );
    };
    await this.ceilings.publishLocked(
      {},
      "platform",
      (scope, row) => {
        if (needsOpenNetwork(scope) && (networkNarrowed || following?.has(row.device_id) === true))
          return true;
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
        return hostsNarrowed(
          scope,
          row,
          orgEffectiveHosts(next, settings.get(row.org_id)),
          (host) => next.egress !== "none" && grantable(row.org_id, host),
        );
      },
      // only a widening resets Full consent: a narrowing keeps what the consent covered
      (beforeMode === "off" && nextMode === "allowed") || networkWidened || hostsWidened,
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

/**
 * Copies a cloud device's B1 snapshot network into its own sandbox network while it has none
 * (migrations 0165 and 0167, the snapshot writer): an allowlist with a non-empty list of strings
 * stays that allowlist, an empty or unreadable one ran closed and becomes `none`; an open snapshot
 * follows the org. Idempotent: only rows still following the org are written.
 */
export async function copyCloudSnapshotNetworks(db: KernelSchemaDb): Promise<void> {
  const readable = sql<boolean>`jsonb_typeof(outer_network -> 'hosts') = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(outer_network -> 'hosts') AS h(v)
      WHERE jsonb_typeof(h.v) <> 'string'
    )`;
  await db
    .updateTable("devices")
    .set({
      network_mode: sql<"allowlist" | "none">`CASE
        WHEN ${readable} AND jsonb_array_length(outer_network -> 'hosts') > 0 THEN 'allowlist'
        ELSE 'none' END`,
      network_hosts: sql<string>`CASE WHEN ${readable} THEN outer_network -> 'hosts'
        ELSE '[]'::jsonb END`,
    })
    .where("source", "=", "cloud")
    .where("network_mode", "is", null)
    .where(sql<boolean>`outer_network ->> 'kind' = 'allowlist'`)
    .execute();
}
