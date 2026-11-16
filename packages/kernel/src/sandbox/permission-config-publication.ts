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
@Injectable()
export class PermissionConfigPublication {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(PermissionCeilingWrites) private readonly ceilings: PermissionCeilingWrites,
  ) {}
  /** Startup only initializes an absent publication; a stale replica cannot overwrite another. */
  @Transactional({ propagation: "requires_new" })
  async initialize(): Promise<void> {
    await this.ceilings.lock({}, "platform");
    await this.db
      .insertInto("permission_config_publication")
      .values({
        id: "platform",
        fingerprint: permissionConfigFingerprint(this.config.get()),
        projection: JSON.stringify(permissionConfigProjection(this.config.get())),
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
  }
  /** CAS publication precedes exposing the new local config. Same-next replicas converge idempotently. */
  @Transactional({ propagation: "requires_new" })
  async publish(before: KernelConfig, next: KernelConfig): Promise<void> {
    await this.ceilings.lock({}, "platform");
    const previous = permissionConfigFingerprint(before),
      fingerprint = permissionConfigFingerprint(next);
    const row = await this.db
      .selectFrom("permission_config_publication")
      .select(["fingerprint", "projection"])
      .where("id", "=", "platform")
      .executeTakeFirst();
    if (
      row &&
      permissionProjectionFingerprint(parsePermissionConfigProjection(row.projection)) !==
        row.fingerprint
    )
      throw new SandboxScopeDeniedError(
        "Published permission projection does not match its fingerprint",
      );
    if (row?.fingerprint === fingerprint) return;
    if (!row || row.fingerprint !== previous)
      throw new SandboxScopeDeniedError(
        "Permission configuration changed on another replica; wait for its current source revision",
      );
    await this.db
      .updateTable("permission_config_publication")
      .set({
        fingerprint,
        projection: JSON.stringify(permissionConfigProjection(next)),
        updated_at: new Date(),
      })
      .where("id", "=", "platform")
      .where("fingerprint", "=", previous)
      .execute();
    const stored = await readStoredDevicesAutoMode(this.db.db);
    const effective = (config: KernelConfig) =>
      resolveDevicesAutoMode(
        config.devices.autoMode,
        config.devices.autoMode === undefined ? undefined : "file",
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
    if (before.sandbox.limits.egress !== next.sandbox.limits.egress)
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
              before.sandbox.limits.egress !== "none" &&
              next.sandbox.limits.egress === "none")
          );
        if (row.method !== "exec" || !("network" in scope) || scope.network.kind !== "allowlist")
          return false;
        const hosts = orgEffectiveHosts(next.sandbox.limits, settings.get(row.org_id));
        return scope.network.hosts.some(
          (host) =>
            !hosts.some((pattern) => coversHost(pattern, host)) &&
            !(
              next.sandbox.limits.egress !== "none" &&
              next.sandbox.limits.orgHosts !== "within" &&
              row.granted_hosts.includes(host)
            ),
        );
      },
      beforeMode !== nextMode,
    );
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
