import type { SandboxBoundary, SandboxPermissionSupport } from "@capybara-hq/plugin-sdk";
import { coversHost, orgEffectiveHosts } from "./modes.js";

/**
 * The device sandbox (approval-only profiles design, "Settings model"): one pure function computes
 * the effective scope boundary, sandbox network and outside-sandbox ceiling of a device from the
 * platform, org, device and provider layers. The device mirrors it in `intersectOperation`.
 *
 * The settings reader (`device-sandbox-settings.ts`) fills {@link DeviceSandboxSettings}; the
 * permission facts assemble the four layers and read the result for admission, the recorded
 * context and the consent fingerprint.
 */

/** The sandbox network: the open public internet or an allowlist. `allowlist` is narrower. */
export type DeviceNetworkMode = "open" | "allowlist";

/** The layer that set a ceiling, named by a disabled option and an actionable error. */
export type DeviceSandboxLayer = "platform" | "org" | "device" | "provider";

/**
 * The platform's device sandbox settings, as the settings reader returns them (env > file / Nacos >
 * the super admin's stored choice > default `allowed`, `open`, `open`).
 */
export interface DeviceSandboxSettings {
  /** `devices.outsideSandbox`: whether any device may be granted escalation outside the sandbox. */
  outsideSandbox: "allowed" | "off";
  network: {
    /** `devices.network.default`: the mode a device follows when nothing narrower chooses. */
    default: DeviceNetworkMode;
    /** `devices.network.ceiling`: the widest mode an org or device may choose. */
    ceiling: DeviceNetworkMode;
  };
}

/** The platform layer: the settings plus the host list and the egress kill switch. */
export interface DeviceSandboxPlatformLayer {
  settings: DeviceSandboxSettings;
  /** `sandbox.limits.allowHosts`. */
  allowHosts: readonly string[];
  /** `sandbox.limits.orgHosts`: whether an org (and a per-call grant) may go beyond `allowHosts`. */
  orgHosts: "extend" | "within";
  /** `sandbox.limits.egress`: `none` closes every sandbox network (the kill switch). */
  egress: "allowlist" | "none";
}

/** The org layer: absent fields follow the platform. */
export interface DeviceSandboxOrgLayer {
  outsideSandbox?: "allowed" | "off";
  deviceNetwork?: {
    default?: DeviceNetworkMode | undefined;
    ceiling?: DeviceNetworkMode | undefined;
    base?: "platform" | "none" | undefined;
    extraHosts?: readonly string[] | undefined;
    excludedHosts?: readonly string[] | undefined;
  };
}

/**
 * The device layer: the device's stored network choice (`devices.network_mode`,
 * `devices.network_hosts`), the same for every provider (device-provider spec §6.3).
 */
export interface DeviceSandboxDeviceLayer {
  /**
   * Null follows the org; `none` is a closed network (a snapshot that ran on an empty or
   * unreadable allowlist). An `allowlist` with no hosts of its own follows its org's hosts.
   */
  networkMode: DeviceNetworkMode | "none" | null;
  networkHosts: readonly string[];
}

/**
 * The provider layer: what the provider's permission support says it can enforce (support v2):
 * its boundary, the networks it enforces and whether a call may run outside its sandbox now.
 */
export interface DeviceSandboxProviderLayer {
  boundary: SandboxBoundary;
  network: { openPublic: boolean; allowlist: boolean; perOperationHosts: boolean };
  outsideSandbox: boolean;
}

/** The effective device sandbox: the same under every permission profile. */
export interface DeviceSandbox {
  boundary: SandboxBoundary;
  /** The effective mode after every ceiling; `allowlist` with no hosts under the kill switch. */
  networkMode: DeviceNetworkMode | "none";
  /** The narrower of the platform and org ceilings (and the provider's outer network). */
  networkCeiling: DeviceNetworkMode | "none";
  /** The allowlist hosts, empty unless `networkMode` is `allowlist`. */
  hosts: readonly string[];
  /** Whether a call may be granted escalation outside the sandbox. */
  outsideSandbox: boolean;
  /** The layer that set each ceiling, or null when nothing narrowed it. */
  layer: { network: DeviceSandboxLayer | null; outsideSandbox: DeviceSandboxLayer | null };
}

/**
 * The hosts of `a` the list `b` covers and the hosts of `b` that `a` covers (wildcards included),
 * lowercased, deduplicated and sorted: never wider than either list.
 */
export function intersectHosts(a: readonly string[], b: readonly string[]): string[] {
  const x = a.map((h) => h.toLowerCase());
  const y = b.map((h) => h.toLowerCase());
  return [
    ...new Set([
      ...x.filter((h) => y.some((p) => coversHost(p, h))),
      ...y.filter((h) => x.some((p) => coversHost(p, h))),
    ]),
  ].sort();
}

/** The org's effective allowlist: the platform's list minus its exclusions, plus its extras. */
export function orgHostsOf(
  platform: Pick<DeviceSandboxPlatformLayer, "egress" | "allowHosts" | "orgHosts">,
  org: DeviceSandboxOrgLayer,
): string[] {
  return orgEffectiveHosts(
    { egress: platform.egress, allowHosts: [...platform.allowHosts], orgHosts: platform.orgHosts },
    org.deviceNetwork === undefined
      ? undefined
      : {
          ...(org.deviceNetwork.base !== undefined && { base: org.deviceNetwork.base }),
          extraHosts: [...(org.deviceNetwork.extraHosts ?? [])],
          excludedHosts: [...(org.deviceNetwork.excludedHosts ?? [])],
        },
  );
}

/**
 * Computes the effective device sandbox from its four layers. Pure; no I/O.
 *
 * - `outsideSandbox`: only when the platform, the org and the provider's support all allow it; an
 *   instance-boundary provider never does.
 * - The network ceiling is the narrower of the platform's and the org's (and what the provider can
 *   enforce); the kill switch closes it (`none`).
 * - The mode is the device's choice (`network_mode`), else the org default, else the platform
 *   default, clamped to the ceiling.
 * - Allowlist hosts are the org's effective hosts, narrowed by the device's own list: a device list
 *   never adds a host, and an empty one adds no narrowing.
 */
export function effectiveDeviceSandbox(
  platform: DeviceSandboxPlatformLayer,
  org: DeviceSandboxOrgLayer,
  device: DeviceSandboxDeviceLayer,
  provider: DeviceSandboxProviderLayer,
): DeviceSandbox {
  const instance = provider.boundary === "instance";
  // running outside the sandbox: the first layer that forbids it names the ceiling
  const outsideLayer: DeviceSandboxLayer | null =
    platform.settings.outsideSandbox !== "allowed"
      ? "platform"
      : org.outsideSandbox === "off"
        ? "org"
        : !provider.outsideSandbox || instance
          ? "provider"
          : null;
  // the network ceiling: platform, then org, then what the provider can enforce
  let ceiling: DeviceNetworkMode | "none";
  let networkLayer: DeviceSandboxLayer | null = null;
  if (platform.egress === "none") {
    ceiling = "none";
    networkLayer = "platform";
  } else if (platform.settings.network.ceiling === "allowlist") {
    ceiling = "allowlist";
    networkLayer = "platform";
  } else if (org.deviceNetwork?.ceiling === "allowlist") {
    ceiling = "allowlist";
    networkLayer = "org";
  } else ceiling = "open";
  if (ceiling !== "none" && !provider.network.allowlist && !provider.network.openPublic) {
    ceiling = "none";
    networkLayer = "provider";
  } else if (ceiling === "open" && !provider.network.openPublic) {
    ceiling = "allowlist";
    networkLayer = "provider";
  }
  // the device's choice, else the org default, else the platform default; then the ceiling
  const chosen: DeviceNetworkMode | "none" =
    device.networkMode ?? org.deviceNetwork?.default ?? platform.settings.network.default;
  let networkMode: DeviceNetworkMode | "none" =
    ceiling === "none" || chosen === "none"
      ? "none"
      : ceiling === "allowlist"
        ? "allowlist"
        : chosen;
  if (networkMode === "allowlist" && !provider.network.allowlist) networkMode = "none";
  let hosts: string[] = [];
  if (networkMode === "allowlist") {
    const orgHosts = orgHostsOf(platform, org);
    // the device's own list narrows the org's hosts; an empty one follows them
    const own = device.networkHosts.length > 0 ? device.networkHosts : null;
    hosts =
      own === null
        ? [...new Set(orgHosts.map((h) => h.toLowerCase()))]
        : intersectHosts(orgHosts, own);
  }
  return {
    boundary: provider.boundary,
    networkMode,
    networkCeiling: ceiling,
    hosts,
    outsideSandbox: outsideLayer === null,
    layer: { network: networkLayer, outsideSandbox: outsideLayer },
  };
}

/**
 * The provider layer of a device from its provider's permission support (support v2): the current
 * runtime report, else the support stored with the device's report. With no support known yet,
 * the kernel assumes the same layer for every provider: the networks open to the device's own
 * choice (the provider still enforces its own, and admission refuses until a report is recorded)
 * and nothing outside the sandbox, which only the provider's support grants.
 */
export function providerLayerOf(
  support: SandboxPermissionSupport | null,
): DeviceSandboxProviderLayer {
  if (support !== null)
    return {
      boundary: support.boundary,
      network: { ...support.network },
      outsideSandbox: support.outsideSandbox,
    };
  return {
    boundary: "operation",
    network: { openPublic: true, allowlist: true, perOperationHosts: true },
    outsideSandbox: false,
  };
}

/**
 * The ceiling of a per-call host grant (approval-only profiles design, "Per-call host grant"):
 * `any` (bounded by the kernel only, minus the org's exclusions) or exactly the `hosts` a grant may
 * name.
 * - Nothing on an instance-boundary device (its provider's network covers the whole instance) or
 *   on a closed network.
 * - An allowlist network ceiling (platform or org) is a hard ceiling: only the org's effective
 *   hosts.
 * - Under an open ceiling, `orgHosts: within` keeps grants within the org's effective hosts (the
 *   platform list minus exclusions, or only the extras the platform list covers under `base:
 *   none`); `extend` allows any host the org does not exclude.
 *
 * An excluded entry is a pattern like an allowlist entry (`*.example.com` excludes every
 * subdomain, never the apex): a host is grantable only when no excluded entry covers it.
 */
export type HostGrantCeiling =
  | { kind: "any"; excluded: readonly string[] }
  | { kind: "hosts"; hosts: readonly string[]; excluded?: readonly string[] };

export function hostGrantCeiling(
  box: Pick<DeviceSandbox, "boundary" | "networkMode" | "networkCeiling"> & {
    layer?: Pick<DeviceSandbox["layer"], "network">;
  },
  platform: Pick<DeviceSandboxPlatformLayer, "egress" | "allowHosts" | "orgHosts">,
  org: DeviceSandboxOrgLayer,
): HostGrantCeiling {
  if (box.boundary === "instance" || box.networkMode === "none" || platform.egress === "none")
    return { kind: "hosts", hosts: [] };
  // the platform's or org's allowlist ceiling is hard; a provider that cannot enforce the open
  // network clamps the sandbox network, not what an org allows per call
  const hard = box.networkCeiling === "allowlist" && box.layer?.network !== "provider";
  return hard || platform.orgHosts === "within"
    ? { kind: "hosts", hosts: orgHostsOf(platform, org) }
    : {
        kind: "any",
        excluded: [...(org.deviceNetwork?.excludedHosts ?? [])].map((h) => h.toLowerCase()),
      };
}

/** Whether a per-call grant may name `host` under `ceiling`. */
export function hostGrantable(ceiling: HostGrantCeiling, host: string): boolean {
  const h = host.toLowerCase();
  if ((ceiling.excluded ?? []).some((x) => coversHost(x.toLowerCase(), h))) return false;
  if (ceiling.kind === "any") return true;
  return ceiling.hosts.some((p) => coversHost(p.toLowerCase(), h));
}

/** A canonical form of a ceiling (sorted, deduplicated, lowercased) for the consent fingerprint. */
export function canonicalHostCeiling(ceiling: HostGrantCeiling): HostGrantCeiling {
  const norm = (l: readonly string[]) => [...new Set(l.map((h) => h.toLowerCase()))].sort();
  if (ceiling.kind === "any") return { kind: "any", excluded: norm(ceiling.excluded) };
  return ceiling.excluded?.length
    ? { kind: "hosts", hosts: norm(ceiling.hosts), excluded: norm(ceiling.excluded) }
    : { kind: "hosts", hosts: norm(ceiling.hosts) };
}

/**
 * Why a per-call grant for `host` is unavailable on this device, naming who can add it, or null
 * when the grant ceiling covers it ({@link hostGrantCeiling}).
 */
export function hostGrantRefusal(
  host: string,
  box: Pick<DeviceSandbox, "boundary" | "networkMode" | "networkCeiling"> & {
    layer?: Pick<DeviceSandbox["layer"], "network">;
  },
  platform: Pick<DeviceSandboxPlatformLayer, "egress" | "allowHosts" | "orgHosts">,
  org: DeviceSandboxOrgLayer,
): string | null {
  const ceiling = hostGrantCeiling(box, platform, org);
  if (hostGrantable(ceiling, host)) return null;
  if (box.networkMode === "none" || platform.egress === "none")
    return "network access is turned off for this device's sandbox";
  if (box.boundary === "instance")
    return `a host cannot be granted per call on this device; add ${host} to the device's network list`;
  return (box.networkCeiling === "allowlist" && box.layer?.network !== "provider") ||
    ceiling.kind === "any"
    ? `an organization admin adds ${host} to the organization's device network list`
    : `${host} is outside the platform's host list; a super admin adds the host`;
}

const MODE_RANK = { none: 0, allowlist: 1, open: 2 } as const;

/**
 * The crossing ceilings a Full access consent covers (approval-only profiles design, "Consent
 * fingerprint"): running outside, the network ceiling and mode and the per-call host ceiling.
 */
export interface ConsentReach {
  outsideSandbox: boolean;
  networkCeiling: DeviceNetworkMode | "none";
  networkMode: DeviceNetworkMode | "none";
  hostCeiling: HostGrantCeiling;
}

/**
 * Whether `now` is within `consented` in every dimension: a narrowing keeps the consent, a widening
 * of any dimension needs a new one (Full access would otherwise auto-approve more).
 */
export function reachWithin(now: ConsentReach, consented: ConsentReach): boolean {
  if (now.outsideSandbox && !consented.outsideSandbox) return false;
  if (MODE_RANK[now.networkCeiling] > MODE_RANK[consented.networkCeiling]) return false;
  if (MODE_RANK[now.networkMode] > MODE_RANK[consented.networkMode]) return false;
  const a = now.hostCeiling,
    b = consented.hostCeiling;
  // every exclusion consented to still holds now: no host it covers became grantable
  const keepsExclusions = (b.excluded ?? []).every(
    (x) => (a.excluded ?? []).some((y) => coversHost(y, x)) || !hostGrantable(a, x),
  );
  if (!keepsExclusions) return false;
  if (a.kind === "any") return b.kind === "any";
  return a.hosts.every((h) => hostGrantable(b, h));
}
