import type { SandboxBoundary } from "@capybara-hq/plugin-sdk";

/**
 * The device sandbox (approval-only profiles design, "Settings model"): one pure function computes
 * the effective scope boundary, sandbox network and outside-sandbox ceiling of a device from the
 * platform, org, device and provider layers. The device mirrors it in `intersectOperation`.
 *
 * W0 interface stub: the types are frozen for the W1 and W2 tasks; the settings reader (T2) fills
 * {@link DeviceSandboxSettings}, the device sandbox task (T5) implements
 * {@link effectiveDeviceSandbox} and may add optional input fields, never rename these.
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
    default?: DeviceNetworkMode;
    ceiling?: DeviceNetworkMode;
    base?: "platform" | "none";
    extraHosts?: readonly string[];
    excludedHosts?: readonly string[];
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

/** Computes the effective device sandbox from its four layers. Pure; no I/O. */
export function effectiveDeviceSandbox(
  platform: DeviceSandboxPlatformLayer,
  org: DeviceSandboxOrgLayer,
  device: DeviceSandboxDeviceLayer,
  provider: DeviceSandboxProviderLayer,
): DeviceSandbox {
  void platform;
  void org;
  void device;
  void provider;
  throw new Error("effectiveDeviceSandbox: not implemented in W0");
}
