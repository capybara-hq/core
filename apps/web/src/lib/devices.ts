import { apiFetch } from "./api";
import type { LocalizedName } from "./catalog";
import { extensionLabel } from "./extension-label";

/**
 * The kernel's devices API (`packages/kernel/src/devices/devices.service.ts`; only the
 * fields the UI uses). Web code never imports kernel code.
 */

/** How much power a device gives an agent's commands (auto mode spec §4). */
export type DeviceMode = "auto" | "sandbox";

/** A device network: the open public network (private ranges and loopback blocked) or an allowlist. */
export type DeviceNetworkKind = "open-public" | "allowlist";

export interface DeviceLimits {
  cpu: number;
  memoryMb: number;
  diskMb: number;
  /** The mode the limits were made with. */
  mode: DeviceMode;
  /** `open-public` for a cloud device in auto mode; the allowlist in sandbox mode. */
  network: { kind: DeviceNetworkKind; hosts: string[] };
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

/**
 * The old sandbox levels (sandbox dev tiers spec §5): only the settings pages still read them
 * until their auto-mode pass; a device itself is 自动 or 沙箱 ({@link DeviceMode}).
 */
export type SandboxTier = "strict" | "dev" | "open";

/** The tiers from the narrowest up. */
export const SANDBOX_TIERS: readonly SandboxTier[] = ["strict", "dev", "open"];

/** Whether tier `a` is above tier `b`. */
export const tierAbove = (a: SandboxTier, b: SandboxTier): boolean =>
  SANDBOX_TIERS.indexOf(a) > SANDBOX_TIERS.indexOf(b);

/** A local device's policy as its machine last reported it (kernel `DeviceLocalPolicySummary`). */
export interface DeviceNetworkPolicy {
  /** The mode the machine runs at: no OS sandbox, or the sandbox with the allowlist below. */
  mode: DeviceMode;
  /** The machine's sandbox-mode allowlist (meaningful in sandbox mode only). */
  allowedDomains: string[];
}

/**
 * A local device's network facts when a machine is connected: the program's features (`policyOpId`:
 * it takes policy changes from the deployment under op ids) and its policy summary (null when it
 * reported none).
 */
export interface DeviceNetwork {
  features: string[];
  policy: DeviceNetworkPolicy | null;
}

/** One mode or policy change of a device (kernel `DeviceModeChangeView`), newest first. */
export interface DeviceModeChange {
  at: string;
  /** `policy`: a local allowlist change; `mode`: the device switched between auto and sandbox. */
  kind: "policy" | "mode";
  add: string[];
  remove: string[];
  /**
   * The mode change (`from` only for a change made on the machine); null when it did not change.
   */
  mode: { from?: DeviceMode | null; to: DeviceMode } | null;
  /** The deciding account's display name (null once the account is gone). */
  by: string | null;
  /** `device`: made or reported on the machine itself. */
  via: "web" | "im" | "device";
  /**
   * What became of a change sent to the machine: `unknown`, its answer never came; `failed`, it
   * did not take effect. Every other row is `applied`.
   */
  outcome: "applied" | "unknown" | "failed";
}

/** A device's mode and network as its owner sees it (kernel `DeviceModeView`, auto mode spec §4.3). */
export interface DeviceModeView {
  /** The mode its commands run at. */
  mode: DeviceMode;
  /** `auto` only while the platform's and the org's `autoMode` allow it. */
  allowedMode: DeviceMode;
  /** Which layer allows auto mode; null when only sandbox mode is allowed. */
  allowedBy: "org" | "platform" | null;
  /** A cloud device's effective network; a local device's sandbox-mode allowlist. */
  network: { kind: DeviceNetworkKind; hosts: string[]; source: "org" | "platform" };
  /** A local device: the mode its machine reported and its own allowlist; null for cloud. */
  local: { reported: DeviceMode | null; allowedDomains: string[] } | null;
  /** A cloud device's instance runs an older mode or network: its next use applies this one. */
  pendingNextUse: boolean;
  /** Its provider applies limits at a file reset, so only that applies the new mode or network. */
  pendingFilesReset: boolean;
  /** Its last mode and policy changes, newest first. */
  recent: DeviceModeChange[];
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
   * none connected.
   */
  network?: DeviceNetwork | null;
  /** Its mode and network (auto mode spec §4.3). */
  mode: DeviceModeView;
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
 * The mark a device carries in lists and pickers (auto mode spec §4): a local device says its mode
 * (自动 `warn`, 沙箱 quiet); a cloud device says its network (开放（挡内网） `warn`, 白名单 quiet).
 */
export type DeviceMarkKind = "auto" | "sandbox" | "open" | "allowlist";

export function deviceModeMark(e: Pick<Device, "source" | "mode">): {
  kind: DeviceMarkKind;
  tone: "warn" | "default";
} {
  const mode = e.mode;
  if (e.source === "local") {
    return mode.mode === "auto"
      ? { kind: "auto", tone: "warn" }
      : { kind: "sandbox", tone: "default" };
  }
  return mode.network.kind === "open-public"
    ? { kind: "open", tone: "warn" }
    : { kind: "allowlist", tone: "default" };
}

/** A change of a local device's policy by its owner (`POST …/devices/:id/policy`). */
export interface DevicePolicyPatch {
  /** Hosts to allow (wildcards `*.` allowed); at most {@link MAX_POLICY_HOSTS}. */
  add?: string[];
  remove?: string[];
  /** The only mode the web may set: the sandbox. Auto mode is switched on at the machine. */
  mode?: "sandbox";
}

/** The most hosts one policy change adds. */
export const MAX_POLICY_HOSTS = 20;

/** Narrows a cloud device to sandbox mode (`PATCH …/devices/:id`). Auto mode is never set here. */
export const setDeviceMode = (orgId: string, id: string, mode: "sandbox") =>
  apiFetch<{ device: Device }>(`${org(orgId)}/${enc(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ mode }),
  });

/** Sent to the machine, which writes it and answers with the policy as written. */
export const updateDevicePolicy = (orgId: string, id: string, patch: DevicePolicyPatch) =>
  apiFetch<{ policy: DeviceNetworkPolicy }>(`${org(orgId)}/${enc(id)}/policy`, {
    method: "POST",
    body: JSON.stringify(patch),
  });
