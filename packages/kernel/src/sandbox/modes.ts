import type { KernelConfig } from "../config/schema.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type { KernelConfigService } from "../infra/config/kernel-config.service.js";
import type { OrgSettings } from "../orgs/settings.service.js";
import { type DevicesAutoMode, readDevicesAutoMode } from "./platform-auto-mode.js";

/**
 * Device modes (auto mode spec §4.1–§4.3): who may choose auto mode, and the network each mode
 * gets. One pure function, {@link effectiveDevicePolicy}, combines the platform's switch
 * (`devices.autoMode`), the org's (`autoMode`, `cloudNetwork`) and the device's own choice (a local
 * machine's reported mode; null follows the platform and the org).
 */

/** A device mode. Not `DeviceMode`, which is the program's os | docker run mode. */
export type SandboxMode = "auto" | "sandbox";

/** A device network: any public address (cloud only), or an allowlist. */
export type NetworkKind = "open-public" | "allowlist";

/** A device network with its hosts (`open-public` carries none). */
export interface DeviceNetwork {
  kind: NetworkKind;
  hosts: string[];
}

/**
 * What the policy reads of the platform: the effective auto-mode switch (`readDevicesAutoMode`:
 * the startup config over the admin console's choice) and the `sandbox.limits` network fields.
 */
export interface DeploymentDevicePolicy {
  autoMode: DevicesAutoMode;
  limits: Pick<KernelConfig["sandbox"]["limits"], "egress" | "allowHosts">;
}

/**
 * The platform side of the policy, read live: the effective auto-mode switch and the
 * `sandbox.limits` network fields (in the caller's transaction when there is one).
 */
export async function readDeploymentDevicePolicy(
  db: KernelSchemaDb,
  config: Pick<KernelConfigService, "get" | "fieldSource">,
): Promise<DeploymentDevicePolicy> {
  const autoMode = await readDevicesAutoMode(db, config);
  return { autoMode: autoMode.mode, limits: config.get().sandbox.limits };
}

/** The org settings the policy reads. */
export type OrgDeviceSettings = Pick<OrgSettings, "autoMode" | "cloudNetwork">;

/** The effective device policy of one device (or of a new device, with no choice of its own). */
export interface EffectiveDevicePolicy {
  /** min(the device's choice, {@link allowedMode}); `auto` unless the device chose sandbox. */
  mode: SandboxMode;
  /** `auto` only when the platform's and the org's `autoMode` both allow it. */
  allowedMode: SandboxMode;
  /** Which layer decided {@link mode}. */
  modeSource: "device" | "org" | "platform";
  /** The cloud network (auto mode's open network, the org's allowlist, or the kill switch). */
  network: DeviceNetwork;
  /**
   * The allowlist a local device's sandbox mode intersects with its own (`sandbox.limits.egress:
   * none` empties it). The exec args always carry it, even when the ceiling is auto: the device
   * may run stricter than the ceiling.
   */
  localAllowedDomains: string[];
}

/** The mode the platform and the org allow: `auto` only when neither turns it off. */
export function allowedDeviceMode(
  platform: DevicesAutoMode,
  org: OrgDeviceSettings["autoMode"],
): SandboxMode {
  return platform === "allowed" && org !== "off" ? "auto" : "sandbox";
}

/**
 * The org's allowlist (the hosts a local device in sandbox mode may reach): the org's own list when
 * it gave one, else `sandbox.limits.allowHosts`; empty under the platform kill switch.
 */
export function orgAllowedDomains(
  deployment: DeploymentDevicePolicy,
  org: OrgDeviceSettings,
): string[] {
  if (deployment.limits.egress === "none") return [];
  return [...(org.cloudNetwork?.allowHosts ?? deployment.limits.allowHosts)];
}

/**
 * The cloud network (auto mode spec §4.3): `open-public` in auto mode while the org's
 * `cloudNetwork` is `open` (the default), else the org's allowlist. `sandbox.limits.egress: none`
 * forces an empty allowlist (the platform kill switch, R20).
 */
export function deviceNetwork(
  deployment: DeploymentDevicePolicy,
  org: OrgDeviceSettings,
  mode: SandboxMode,
): DeviceNetwork {
  if (deployment.limits.egress === "none") return { kind: "allowlist", hosts: [] };
  // auto mode is 开放挡内网 whatever the org says; only sandbox mode applies `cloudNetwork`
  if (mode === "auto") return { kind: "open-public", hosts: [] };
  if ((org.cloudNetwork?.mode ?? "open") === "open") {
    return { kind: "open-public", hosts: [] };
  }
  return { kind: "allowlist", hosts: orgAllowedDomains(deployment, org) };
}

/**
 * The org's sandbox-mode network, from the deployment default and the org's `cloudNetwork` choice:
 * `open-public` when either says open, else the org's hosts over the deployment's list.
 */
export function orgSandboxNetwork(
  deployment: { mode: "open" | "allowlist"; allowHosts: string[] },
  org: OrgDeviceSettings["cloudNetwork"],
): DeviceNetwork {
  if ((org?.mode ?? deployment.mode) === "open") return { kind: "open-public", hosts: [] };
  return { kind: "allowlist", hosts: [...(org?.allowHosts ?? deployment.allowHosts)] };
}

/**
 * The effective device policy. `deviceMode` is the device's own choice (a local machine's
 * reported mode; null = follow the platform and the org). A stored mode the ceiling forbids is cut,
 * never honoured; the network follows the resulting mode.
 */
export function effectiveDevicePolicy(
  deployment: DeploymentDevicePolicy,
  org: OrgDeviceSettings,
  deviceMode: SandboxMode | null,
): EffectiveDevicePolicy {
  const allowedMode = allowedDeviceMode(deployment.autoMode, org.autoMode);
  const mode: SandboxMode = allowedMode === "sandbox" ? "sandbox" : (deviceMode ?? "auto");
  const modeSource: EffectiveDevicePolicy["modeSource"] =
    mode === "sandbox"
      ? deviceMode === "sandbox" && allowedMode === "auto"
        ? "device"
        : deployment.autoMode === "allowed"
          ? "org"
          : "platform"
      : deviceMode === "auto"
        ? "device"
        : org.autoMode === "allowed"
          ? "org"
          : "platform";
  return {
    mode,
    allowedMode,
    modeSource,
    network: deviceNetwork(deployment, org, mode),
    localAllowedDomains: orgAllowedDomains(deployment, org),
  };
}

/**
 * What decides whether a running cloud instance must change (auto mode spec §4.2): its mode and
 * the kind of its network only. `hosts` and resources reach instances created afterwards.
 */
export interface AppliedLimits {
  mode: SandboxMode;
  network: DeviceNetwork;
}

/** The {@link AppliedLimits} of `limits`. */
export const appliedOf = (limits: {
  mode: SandboxMode;
  network: DeviceNetwork;
}): AppliedLimits => ({
  mode: limits.mode,
  network: { kind: limits.network.kind, hosts: [...limits.network.hosts] },
});

/** Whether `a` and `b` are the same mode and network kind (null, unknown, is never the same). */
export const sameApplied = (a: AppliedLimits | null | undefined, b: AppliedLimits): boolean =>
  a != null && a.mode === b.mode && a.network.kind === b.network.kind;

const isMode = (v: unknown): v is SandboxMode => v === "auto" || v === "sandbox";

function appliedFrom(v: unknown): AppliedLimits | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isMode(o.mode)) return null;
  const n = o.network;
  if (typeof n !== "object" || n === null) return null;
  const net = n as Record<string, unknown>;
  if (net.kind !== "open-public" && net.kind !== "allowlist") return null;
  const hosts = Array.isArray(net.hosts)
    ? net.hosts.filter((h): h is string => typeof h === "string")
    : [];
  return { mode: o.mode, network: { kind: net.kind, hosts } };
}

/**
 * `device_instances.instance_limits` read leniently: `applied` is what the instance runs with
 * (null: unknown, e.g. an instance made before auto mode recorded tiers, which differs from every
 * effective value); `unapplied` is a newer value the provider could not apply without a file
 * reset.
 */
export function readInstanceLimits(v: unknown): {
  applied: AppliedLimits | null;
  unapplied: AppliedLimits | null;
} {
  if (typeof v !== "object" || v === null) return { applied: null, unapplied: null };
  return {
    applied: appliedFrom(v),
    unapplied: appliedFrom((v as { unapplied?: unknown }).unapplied),
  };
}

/** The JSON written to `device_instances.instance_limits`. */
export function instanceLimitsJson(
  applied: AppliedLimits | null,
  unapplied?: AppliedLimits,
): string | null {
  if (applied === null && unapplied === undefined) return null;
  return JSON.stringify({
    ...(applied !== null && appliedOf(applied)),
    ...(unapplied !== undefined && { unapplied: appliedOf(unapplied) }),
  });
}
