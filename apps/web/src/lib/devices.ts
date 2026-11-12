import { apiFetch } from "./api";
import type { LocalizedName } from "./catalog";
import { extensionLabel } from "./extension-label";

/**
 * The kernel's devices API (`packages/kernel/src/devices/devices.service.ts`; only the
 * fields the UI uses). Web code never imports kernel code.
 */

export interface DeviceLimits {
  cpu: number;
  memoryMb: number;
  diskMb: number;
  egress: "none" | "allowlist" | "open";
  allowHosts: string[];
}

/** The machine connected to a local device (its unrevoked one). */
export interface DeviceMachine {
  id: string;
  name: string;
  /** As the program reports it: `darwin`, `linux`. */
  os: string;
  /** `os`: the system sandbox; `docker`: a container. */
  mode: "os" | "docker" | null;
  programVersion: string | null;
  lastSeenAt: string | null;
}

/** A sandbox level (sandbox dev tiers spec §5): 严格 / 开发 / 开放. */
export type SandboxTier = "strict" | "dev" | "open";

/** The tiers from the narrowest up. */
export const SANDBOX_TIERS: readonly SandboxTier[] = ["strict", "dev", "open"];

/** Whether tier `a` is above tier `b`. */
export const tierAbove = (a: SandboxTier, b: SandboxTier): boolean =>
  SANDBOX_TIERS.indexOf(a) > SANDBOX_TIERS.indexOf(b);

/** A local device's policy as its machine last reported it (kernel `DeviceLocalPolicySummary`). */
export interface DeviceNetworkPolicy {
  /** The tier the device owner chose on the machine (absent = follows the org's default). */
  tier?: SandboxTier;
  /** The tier the device ran its last command at. */
  effectiveTier: SandboxTier;
  isolation: "sandbox" | "none";
  /**
   * Whether `dev` lets commands reach local servers on this machine: `off-proxy-detected` when a
   * local proxy or Docker TCP port was found (the proxy guard), `off` in `strict`.
   */
  localhost: "on" | "off-proxy-detected" | "off";
  /** Unix sockets: `roots` under the device's roots, `all-masked` (Linux: masked), `off`. */
  unixSockets: "roots" | "all-masked" | "off";
  allowedDomains: string[];
  /** `off`: the machine refuses every widening from the deployment (set only on the machine). */
  remoteGrants: "owner" | "off";
}

/**
 * A local device's network facts (network ask-to-allow spec §5.4, §7): the program's features
 * (`policyOp`: it takes policy changes from the deployment; `tiers`: it knows the sandbox levels)
 * and its policy summary (null when it reported none).
 */
export interface DeviceNetwork {
  features: string[];
  policy: DeviceNetworkPolicy | null;
}

/** One sandbox change of a device (kernel `DeviceSandboxChangeView`), newest first. */
export interface DeviceSandboxChange {
  at: string;
  /** `policy`: a local policy change; `tier`: a cloud device's tier; `isolation`: reported. */
  kind: "policy" | "tier" | "isolation";
  add: string[];
  remove: string[];
  /** The tier set (`to: null`: follow the org's default); null when it did not change. */
  tier: { to: SandboxTier | null } | null;
  isolation: "sandbox" | "none" | null;
  /** The deciding account's display name (null once the account is gone). */
  by: string | null;
  via: "web" | "im" | "device";
  /** The machine answered with the policy as written (false: the answer never came). */
  confirmed: boolean;
}

/** A device's sandbox level as its owner sees it (kernel `DeviceSandboxView`, spec §11.1). */
export interface DeviceSandbox {
  /** The tier the owner chose; null follows the org's default. */
  tier: SandboxTier | null;
  /** The tier its commands run at. */
  effectiveTier: SandboxTier;
  /** The highest tier the device may reach (the org's and the platform's max). */
  ceiling: SandboxTier;
  /** Which ceiling lowered the chosen tier; null when none did. */
  cappedBy: "org" | "platform" | null;
  /** The org's default tier for devices that choose none. */
  defaultTier: SandboxTier;
  /** The org and the platform let a local device run without a sandbox. */
  allowUnsandboxed: boolean;
  /** `none`: a local device runs its commands without a sandbox (set on the machine). */
  isolation: "sandbox" | "none";
  /** A cloud device's new tier applies at its next use, files kept. */
  pendingNextUse: boolean;
  /** A cloud device's new tier waits for a file reset. */
  pendingFilesReset: boolean;
  recent: DeviceSandboxChange[];
}

export interface Device {
  id: string;
  /**
   * null for the person's default device (shown as 个人设备 / "Personal") and for a former
   * default (shown from `demotedFrom`); see {@link deviceName}.
   */
  name: string | null;
  isDefault: boolean;
  /**
   * A former default demoted by a sandbox provider switch: the provider it was demoted from, its
   * display name (null: show the id) and its place among the unnamed ones of that provider (1, 2,
   * …). It becomes the default again when the platform switches back to that provider.
   */
  demotedFrom: { provider: string; displayName: LocalizedName | null; ordinal: number } | null;
  ownerKind: "personal";
  /** `local`: a machine connected with `capybara-device` (provider `@local`). */
  source: "cloud" | "local";
  provider: string | null;
  /** Its provider is there: the deployment's current sandbox provider, or `@local`. */
  available: boolean;
  /** A local device: its machine is connected now; null for a cloud one. */
  online: boolean | null;
  /** A local device's connected machine; null for a cloud one, or when none is connected. */
  machine: DeviceMachine | null;
  /**
   * A local device's network facts while a machine is connected; null for a cloud device or
   * none connected (absent from older kernels).
   */
  network?: DeviceNetwork | null;
  /** Its sandbox level (absent from older kernels). */
  sandbox?: DeviceSandbox;
  sessionIsolation: boolean;
  /** Its file system is gone at the provider; resetting the files makes it usable again. */
  filesLost: boolean;
  instance: { status: "running" | "suspended"; lastUsedAt: string } | null;
  limits: DeviceLimits;
  createdAt: string;
}

export interface DeviceList {
  items: Device[];
  defaultId: string | null;
  lastUsedId: string | null;
  /** The platform has a sandbox provider: new cloud devices can be made. */
  cloudAvailable: boolean;
}

/**
 * What a device is doing, in the order the page decides: a missing provider wins; a local
 * device is online or offline (its machine's connection).
 */
export type DeviceState =
  | "unavailable"
  | "filesLost"
  | "running"
  | "suspended"
  | "notStarted"
  | "online"
  | "offline";

export function deviceState(e: Device): DeviceState {
  if (!e.available) return "unavailable";
  if (e.source === "local") return e.online === true ? "online" : "offline";
  if (e.filesLost) return "filesLost";
  return e.instance?.status ?? "notStarted";
}

/**
 * A device's name for people: its own name, else 个人设备 / "Personal" for the default, else
 * for a former default 个人设备（Docker 沙箱） / "Personal (Docker sandbox)" (the provider's display
 * name, its id when it has none), with " 2", " 3", … after the first of the same provider.
 */
export function deviceName(
  e: Pick<Device, "name" | "demotedFrom">,
  text: { personal: string; demoted(provider: string): string },
  locale: "zh" | "en",
): string {
  if (e.name !== null) return e.name;
  const d = e.demotedFrom;
  if (!d) return text.personal;
  const provider = extensionLabel({ name: d.provider, displayName: d.displayName }, locale);
  return text.demoted(provider) + (d.ordinal > 1 ? ` ${d.ordinal}` : "");
}

/**
 * Whether a new conversation can be bound to it now: its provider is there, its files are not
 * lost and, for a local device, its machine is online.
 */
export const devicePickable = (e: Device): boolean => {
  const state = deviceState(e);
  return state !== "unavailable" && state !== "filesLost" && state !== "offline";
};

/** A device name as the kernel limits it (trimmed, 1-64 characters). */
export const isDeviceName = (s: string): boolean => {
  const n = s.trim().length;
  return n >= 1 && n <= 64;
};

const org = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/devices`;
const enc = encodeURIComponent;

export const listDevices = (orgId: string) => apiFetch<DeviceList>(org(orgId));

export const getDevice = (orgId: string, id: string) =>
  apiFetch<{ device: Device }>(`${org(orgId)}/${enc(id)}`);

export const createDevice = (orgId: string, name: string) =>
  apiFetch<{ device: Device }>(org(orgId), {
    method: "POST",
    body: JSON.stringify({ name: name.trim() }),
  });

export const renameDevice = (orgId: string, id: string, name: string) =>
  apiFetch<{ device: Device }>(`${org(orgId)}/${enc(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name: name.trim() }),
  });

export const deleteDevice = (orgId: string, id: string) =>
  apiFetch<void>(`${org(orgId)}/${enc(id)}`, { method: "DELETE" });

/** Disconnects a local device's machine (its credential is revoked). */
export const revokeDeviceMachine = (orgId: string, id: string) =>
  apiFetch<void>(`${org(orgId)}/${enc(id)}/machine`, { method: "DELETE" });

export const resetDeviceFiles = (orgId: string, id: string) =>
  apiFetch<void>(`${org(orgId)}/${enc(id)}/files/reset`, { method: "POST" });

/**
 * Whether the machine itself is set to run without a sandbox (its reported raw value) while the
 * platform no longer counts it as unsandboxed because the level is below 开放: the device refuses
 * every command then (spec §11.1).
 */
export const deviceUnsandboxedRefused = (e: Pick<Device, "sandbox" | "network">): boolean =>
  e.sandbox !== undefined &&
  e.sandbox.isolation !== "none" &&
  e.network?.policy?.isolation === "none";

/**
 * The mark a device carries in lists and pickers (spec §11.1): 不使用沙箱 (`fail`) when it runs
 * without a sandbox (or is set to and refuses its commands), 开放 (`warn`) when its commands run at
 * the open level; none otherwise.
 */
export function deviceSandboxMark(
  e: Pick<Device, "sandbox" | "network">,
): { kind: "unsandboxed"; tone: "fail" } | { kind: "open"; tone: "warn" } | null {
  const s = e.sandbox;
  if (s === undefined) return null;
  if (s.isolation === "none" || deviceUnsandboxedRefused(e))
    return { kind: "unsandboxed", tone: "fail" };
  if (s.effectiveTier === "open") return { kind: "open", tone: "warn" };
  return null;
}

/** Whether a device has a level card above its ceiling (the page then says who caps it). */
export const deviceCapped = (e: Pick<Device, "sandbox"> | undefined): boolean =>
  e?.sandbox !== undefined && e.sandbox.ceiling !== "open";

/** A change of a local device's policy by its owner (`POST …/devices/:id/policy`). */
export interface DevicePolicyPatch {
  /** Hosts to allow (wildcards `*.` allowed); at most {@link MAX_POLICY_HOSTS}. */
  add?: string[];
  remove?: string[];
  /** The tier to set; null follows the org's default. */
  tier?: SandboxTier | null;
  /** Only ever `sandbox`: turning the sandbox off happens on the machine alone. */
  isolation?: "sandbox";
}

/** The most hosts one policy change adds. */
export const MAX_POLICY_HOSTS = 20;

/** Sent to the machine, which writes it and answers with the policy as written. */
export const updateDevicePolicy = (orgId: string, id: string, patch: DevicePolicyPatch) =>
  apiFetch<{ policy: DeviceNetworkPolicy }>(`${org(orgId)}/${enc(id)}/policy`, {
    method: "POST",
    body: JSON.stringify(patch),
  });

/** Sets a cloud device's tier (`PATCH …/devices/:id`; null follows the org's default). */
export const setDeviceTier = (orgId: string, id: string, tier: SandboxTier | null) =>
  apiFetch<{ device: Device }>(`${org(orgId)}/${enc(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ tier }),
  });
