import type { KernelConfig } from "../config/schema.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type { KernelConfigService } from "../infra/config/kernel-config.service.js";
import type { DeviceNetworkSetting, OrgSettings } from "../orgs/settings.service.js";
import {
  type OutsideSandboxPermission as FullAccessPermission,
  readDeviceSandboxSettings,
} from "./device-sandbox-settings.js";

/**
 * Device modes (auto mode spec §4.1–§4.3): who may choose auto mode, and the network each mode
 * gets. One pure function, {@link effectiveDevicePolicy}, combines the platform's switch
 * (`devices.fullAccess`), the org's (`fullAccess`, `cloudNetwork`) and the device's owner ceiling (a
 * local machine's owner report, a cloud device's B1 snapshot; null follows the platform and the org).
 * It is a ceiling only: no device-chosen default mode selects how an operation runs (permission
 * runtime cutover 8.6); the conversation's permission profile does, within this ceiling.
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
 * What the policy reads of the platform: the effective Full switch (`readDevicesFullAccess`:
 * the startup config over the admin console's choice) and the `sandbox.limits` network fields.
 */
export interface DeploymentDevicePolicy {
  fullAccess: FullAccessPermission;
  limits: NetworkLimits;
}

/**
 * The platform's network fields (`sandbox.limits`): the kill switch, the allowlist and whether
 * organizations may go beyond it (org egress ceiling spec §D2).
 */
export type NetworkLimits = Pick<
  KernelConfig["sandbox"]["limits"],
  "egress" | "allowHosts" | "orgHosts"
>;

/** Whether the allowlist entry `pattern` admits `host` (`*.x.com`: subdomains, never the apex). */
export const coversHost = (pattern: string, host: string): boolean =>
  pattern === host || (pattern.startsWith("*.") && host.endsWith(pattern.slice(1)));

/**
 * Whether `host` is beyond the platform's ceiling: `sandbox.limits.orgHosts` is `within` and no
 * entry of `sandbox.limits.allowHosts` covers it (a wildcard host is covered by a wider wildcard).
 * Only a super admin can allow such a host.
 */
export function orgHostOutsideCeiling(limits: NetworkLimits, host: string): boolean {
  if (limits.orgHosts !== "within") return false;
  const h = host.toLowerCase();
  return !limits.allowHosts.some((p) => coversHost(p.toLowerCase(), h));
}

/**
 * The org's effective allowlist (org egress ceiling spec §D1): empty under the kill switch; else
 * the org's extras (only those inside the ceiling under `within`) on top of the platform's list
 * minus the org's exclusions, or the extras alone when the org's base is `none`. The one place
 * that combines the platform's hosts with the org's.
 */
export function orgEffectiveHosts(
  limits: NetworkLimits,
  org: DeviceNetworkSetting | undefined,
): string[] {
  if (limits.egress === "none") return [];
  const extra = (org?.extraHosts ?? []).filter((h) => !orgHostOutsideCeiling(limits, h));
  if (org?.base === "none") return [...new Set(extra)];
  const excluded = new Set(org?.excludedHosts ?? []);
  return [...new Set([...limits.allowHosts.filter((h) => !excluded.has(h)), ...extra])];
}

/**
 * The org's cloud network in sandbox mode (spec §D2): the allowlist under the kill switch or the
 * platform ceiling (`orgHosts: within`), else the org's mode (open by default).
 */
export function orgCloudMode(
  limits: NetworkLimits,
  org: DeviceNetworkSetting | undefined,
): "open" | "allowlist" {
  if (limits.egress === "none" || limits.orgHosts === "within") return "allowlist";
  return org?.ceiling === "allowlist" || org?.default === "allowlist" ? "allowlist" : "open";
}

/**
 * The platform side of the policy, read live: the effective auto-mode switch and the
 * `sandbox.limits` network fields (in the caller's transaction when there is one).
 */
export async function readDeploymentDevicePolicy(
  db: KernelSchemaDb,
  config: Pick<KernelConfigService, "get" | "fieldSource">,
): Promise<DeploymentDevicePolicy> {
  const settings = await readDeviceSandboxSettings(db, config);
  return { fullAccess: settings.outsideSandbox, limits: config.get().sandbox.limits };
}

/** The org settings the policy reads. */
export type OrgDeviceSettings = Pick<OrgSettings, "outsideSandbox" | "deviceNetwork">;

/** The effective device policy of one device (or of a new device, with no choice of its own). */
export interface EffectiveDevicePolicy {
  /** min(the device's owner ceiling, {@link allowedMode}); `auto` unless that ceiling is sandbox. */
  mode: SandboxMode;
  /** `auto` only when the platform's and the org's `fullAccess` both allow it. */
  allowedMode: SandboxMode;
  /** The cloud network (auto mode's open network, the org's allowlist, or the kill switch). */
  network: DeviceNetwork;
  /**
   * The allowlist a local device's sandbox mode intersects with its own (`sandbox.limits.egress:
   * none` empties it). The exec args always carry it, even when the ceiling is auto: the device
   * may run stricter than the ceiling.
   */
  localAllowedDomains: string[];
}

/**
 * How far restricted work may root outside the workspace now (B2), the one rule the command
 * review (`DevicesService.projectReach`) and admission's working root both read: a local device
 * follows its owner's reported reach within a device ceiling that allows auto; a cloud device
 * reaches beyond its workspace only in auto mode.
 */
export function projectReachOf(
  source: string,
  policy: Pick<EffectiveDevicePolicy, "mode" | "allowedMode">,
  ownerReach: string | null | undefined,
): "workspace" | "os-user" {
  if (source !== "local") return policy.mode === "auto" ? "os-user" : "workspace";
  return policy.allowedMode === "auto" && ownerReach === "os-user" ? "os-user" : "workspace";
}

/** The mode the platform and the org allow: `auto` only when neither turns it off. */
export function allowedDeviceMode(
  platform: FullAccessPermission,
  org: OrgDeviceSettings["outsideSandbox"],
): SandboxMode {
  return platform === "allowed" && org !== "off" ? "auto" : "sandbox";
}

/** The org's allowlist (the hosts a local device in sandbox mode may reach): {@link orgEffectiveHosts}. */
export function orgAllowedDomains(
  deployment: DeploymentDevicePolicy,
  org: OrgDeviceSettings,
): string[] {
  return orgEffectiveHosts(deployment.limits, org.deviceNetwork);
}

/**
 * The cloud network (auto mode spec §4.3): `open-public` in auto mode; in sandbox mode the org's
 * cloud network ({@link orgCloudMode}). `sandbox.limits.egress: none` forces an empty allowlist
 * (the platform kill switch, R20).
 */
export function deviceNetwork(
  deployment: DeploymentDevicePolicy,
  org: OrgDeviceSettings,
  mode: SandboxMode,
): DeviceNetwork {
  if (deployment.limits.egress === "none") return { kind: "allowlist", hosts: [] };
  // auto mode is 开放挡内网 whatever the org says; only sandbox mode applies `cloudNetwork`
  if (mode === "auto") return { kind: "open-public", hosts: [] };
  if (orgCloudMode(deployment.limits, org.deviceNetwork) === "open") {
    return { kind: "open-public", hosts: [] };
  }
  return { kind: "allowlist", hosts: orgAllowedDomains(deployment, org) };
}

/**
 * The effective device policy. `deviceMode` is the device's owner ceiling (a local machine's owner
 * report, a cloud device's B1 snapshot or narrowing switch; null = follow the platform and the
 * org). A stored mode the platform or org forbids is cut, never honoured; the network follows the
 * resulting mode.
 */
export function effectiveDevicePolicy(
  deployment: DeploymentDevicePolicy,
  org: OrgDeviceSettings,
  deviceMode: SandboxMode | null,
  /** A cloud device's B1 outer network snapshot: the network never goes beyond it. */
  outer: DeviceNetwork | null = null,
): EffectiveDevicePolicy {
  const allowedMode = allowedDeviceMode(deployment.fullAccess, org.outsideSandbox);
  const mode: SandboxMode = allowedMode === "sandbox" ? "sandbox" : (deviceMode ?? "auto");
  return {
    mode,
    allowedMode,
    network:
      outer === null
        ? deviceNetwork(deployment, org, mode)
        : intersectNetworks(deviceNetwork(deployment, org, mode), outer),
    localAllowedDomains: orgAllowedDomains(deployment, org),
  };
}

/** A network with its hosts lowercased, sorted and deduplicated (`open-public` carries none). */
export const normalizeNetwork = (n: DeviceNetwork): DeviceNetwork =>
  n.kind === "open-public"
    ? { kind: "open-public", hosts: [] }
    : { kind: "allowlist", hosts: [...new Set(n.hosts.map((h) => h.toLowerCase()))].sort() };

/**
 * The narrower of two networks (B1): the open public network is no limit; two allowlists keep the
 * hosts (or wildcards) of each that the other covers. Never wider than either.
 */
export function intersectNetworks(a: DeviceNetwork, b: DeviceNetwork): DeviceNetwork {
  if (a.kind === "open-public") return normalizeNetwork(b);
  if (b.kind === "open-public") return normalizeNetwork(a);
  const x = normalizeNetwork(a).hosts;
  const y = normalizeNetwork(b).hosts;
  return normalizeNetwork({
    kind: "allowlist",
    hosts: [
      ...x.filter((h) => y.some((p) => coversHost(p, h))),
      ...y.filter((h) => x.some((p) => coversHost(p, h))),
    ],
  });
}

/** Whether `a` and `b` are the same mode, network kind and host set (null is never the same). */
export const sameAppliedExactly = (
  a: AppliedLimits | null | undefined,
  b: AppliedLimits,
): boolean =>
  a != null &&
  a.mode === b.mode &&
  JSON.stringify(normalizeNetwork(a.network)) === JSON.stringify(normalizeNetwork(b.network));

/** A cloud device's B1 per-device authority: its owner Full ceiling and its outer network. */
export interface CloudOwnerSnapshot {
  fullAccess: boolean;
  outerNetwork: DeviceNetwork;
}

/**
 * The B1 snapshot of a cloud device from its old effective policy (computed by the old algorithm,
 * `egress: none` included): Full where the old mode was auto, the old effective network as the
 * outer boundary. Known applied limits narrow it by intersection, never widen it: an instance that
 * really ran stricter keeps that boundary (`applied` null: unknown, nothing to intersect).
 */
export function cloudSnapshotOf(
  old: Pick<EffectiveDevicePolicy, "mode" | "network">,
  applied: AppliedLimits | null = null,
): CloudOwnerSnapshot {
  const fullAccess = old.mode === "auto" && (applied === null || applied.mode === "auto");
  return {
    fullAccess,
    outerNetwork:
      applied === null
        ? normalizeNetwork(old.network)
        : intersectNetworks(old.network, applied.network),
  };
}

/**
 * The mode a cloud device chose: the narrower of its old narrowing switch and its B1 owner
 * ceiling (false narrows to sandbox, true or not snapshotted follows the platform and the org). An
 * explicit sandbox switch (an old replica's write included) is never overridden.
 */
export const cloudChosenMode = (row: {
  mode: "sandbox" | null;
  owner_full_access: boolean | null;
}): SandboxMode | null =>
  row.mode === "sandbox" || row.owner_full_access === false ? "sandbox" : null;

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

/** Whether `a` and `b` are the same mode, network kind and host set (null is never the same). */
export const sameAppliedExact = (a: AppliedLimits | null | undefined, b: AppliedLimits): boolean =>
  sameApplied(a, b) &&
  [...new Set(a?.network.hosts ?? [])].sort().join("\n") ===
    [...new Set(b.network.hosts)].sort().join("\n");

/**
 * Whether applied limits `a` are more permissive than desired limits `b` in any dimension (spec
 * §124): auto where `b` is sandbox, open public addresses where `b` is an allowlist, or an
 * allowlisted host `b`'s allowlist does not cover. Narrower or equal is false; unknown (null) is
 * false here (callers treat unknown separately).
 */
export function appliedWider(a: AppliedLimits | null | undefined, b: AppliedLimits): boolean {
  if (a == null) return false;
  if (a.mode === "auto" && b.mode === "sandbox") return true;
  if (b.network.kind === "open-public") return false;
  if (a.network.kind === "open-public") return true;
  return a.network.hosts.some((host) => !b.network.hosts.some((p) => coversHost(p, host)));
}

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
