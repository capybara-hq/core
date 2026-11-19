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
 * The device layer: a local device's owner ceiling (on-disk, reported over the protocol), or a cloud
 * device's stored network choice (`devices.network_mode`, `devices.network_hosts`).
 */
export type DeviceSandboxDeviceLayer =
  | {
      location: "local";
      outsideSandbox: boolean;
      network: DeviceNetworkMode;
      allowedDomains: readonly string[];
      restrictedProjectReach: "workspace" | "os-user";
    }
  | {
      location: "cloud";
      /** Null follows the org. */
      networkMode: DeviceNetworkMode | null;
      networkHosts: readonly string[];
    };

/** The provider layer: what the runtime reports (support v2) and, for a cloud device, its outer network. */
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
  restrictedProjectReach: "workspace" | "os-user";
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

/**
 * Computes the effective device sandbox from its four layers. Pure; no I/O.
 *
 * - `outsideSandbox`: only when the platform, the org, the device owner and the provider all allow
 *   it; a cloud device and an instance-boundary provider never do.
 * - The network ceiling is the narrower of the platform's and the org's (and what the provider can
 *   enforce); the kill switch closes it (`none`).
 * - The mode is the device's choice (a local owner's network, a cloud device's `network_mode`),
 *   else the org default, else the platform default, clamped to the ceiling.
 * - Allowlist hosts are the org's effective hosts, narrowed by the device's own list: a device list
 *   never adds a host. A cloud device's empty list adds no narrowing; a local owner's allowlist is
 *   the machine's ceiling, so an empty one allows no host (as the device enforces it).
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
          : device.location === "cloud" || !device.outsideSandbox
            ? "device"
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
  const chosen: DeviceNetworkMode =
    device.location === "local"
      ? device.network
      : (device.networkMode ?? org.deviceNetwork?.default ?? platform.settings.network.default);
  let networkMode: DeviceNetworkMode | "none" =
    ceiling === "none" ? "none" : ceiling === "allowlist" ? "allowlist" : chosen;
  if (networkMode === "allowlist" && !provider.network.allowlist) networkMode = "none";
  // a local owner's allowlist is a ceiling only the machine widens
  if (networkLayer === null && device.location === "local" && device.network === "allowlist")
    networkLayer = "device";
  let hosts: string[] = [];
  if (networkMode === "allowlist") {
    const orgHosts = orgEffectiveHosts(
      {
        egress: platform.egress,
        allowHosts: [...platform.allowHosts],
        orgHosts: platform.orgHosts,
      },
      org.deviceNetwork === undefined
        ? undefined
        : {
            ...(org.deviceNetwork.base !== undefined && { base: org.deviceNetwork.base }),
            extraHosts: [...(org.deviceNetwork.extraHosts ?? [])],
            excludedHosts: [...(org.deviceNetwork.excludedHosts ?? [])],
          },
    );
    // a local owner's allowlist is the machine's own ceiling, which the device enforces on every
    // request (an empty one allows nothing); a cloud device's empty list follows its org's hosts
    // (an owner whose network is open narrows nothing: the device takes the kernel's hosts)
    const own =
      device.location === "local"
        ? device.network === "allowlist"
          ? device.allowedDomains
          : null
        : device.networkHosts.length > 0
          ? device.networkHosts
          : null;
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
    restrictedProjectReach:
      device.location === "local" &&
      platform.settings.outsideSandbox === "allowed" &&
      org.outsideSandbox !== "off" &&
      device.restrictedProjectReach === "os-user"
        ? "os-user"
        : "workspace",
    layer: { network: networkLayer, outsideSandbox: outsideLayer },
  };
}

/**
 * The provider layer of a device: its recorded runtime report (support v2) when one is current,
 * else what the kernel assumes before the device starts (the device and its provider still
 * enforce, and admission refuses until a report is recorded): a local device runs per operation
 * and may run outside; a cloud device's instance is its sandbox.
 */
export function providerLayerOf(
  report: SandboxPermissionSupport | null,
  location: "local" | "cloud",
): DeviceSandboxProviderLayer {
  if (report !== null)
    return {
      boundary: report.boundary,
      network: { ...report.network },
      outsideSandbox: report.outsideSandbox,
    };
  return location === "local"
    ? {
        boundary: "operation",
        network: { openPublic: true, allowlist: true, perOperationHosts: true },
        outsideSandbox: true,
      }
    : {
        boundary: "instance",
        network: { openPublic: true, allowlist: true, perOperationHosts: false },
        outsideSandbox: false,
      };
}
