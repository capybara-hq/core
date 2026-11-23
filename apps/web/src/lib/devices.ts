import { apiFetch } from "./api";
import type { LocalizedName } from "./catalog";
import { extensionLabel } from "./extension-label";
import type { SetupGuideRef } from "./setup-guides";

/**
 * The kernel's devices API (`packages/kernel/src/devices/devices.service.ts`; only the
 * fields the UI uses). Web code never imports kernel code.
 */

/** A device network: the open public network (private ranges and loopback blocked) or an allowlist. */
export type DeviceNetworkKind = "open-public" | "allowlist";

export interface DeviceLimits {
  cpu: number;
  memoryMb: number;
  diskMb: number;
  /** Mirrored from the kernel view; the web reads `sandbox` (the effective network) instead. */
  network: { kind: DeviceNetworkKind; hosts: string[] };
}

/** The machine signed in to a dial-in device (its unrevoked one). */
export interface DeviceMachine {
  id: string;
  name: string;
  /** As the program reports it: `darwin`, `linux`. */
  os: string;
  programVersion: string | null;
  lastSeenAt: string | null;
}

/** A cloud device's stored network (kernel `DeviceNetworkSetting`): `mode` null follows its org. */
export interface DeviceNetworkSetting {
  mode: DeviceNetworkMode | null;
  hosts: string[];
}

/** One setting change of a device (kernel `DeviceSettingChangeView`), newest first. */
export interface DeviceSettingChange {
  at: string;
  kind: "network";
  network: { from: DeviceNetworkSetting; to: DeviceNetworkSetting };
  /** The deciding account (null once the account is gone). */
  by: { id: string; name: string; avatarUrl: string | null } | null;
  /** `agent`: an agent's Platform tool call; `token`: an API token. */
  via: "web" | "im" | "agent" | "token";
}

/** A device sandbox network: the open internet (private networks blocked), an allowlist or closed. */
export type DeviceNetworkMode = "open" | "allowlist" | "none";

/**
 * The layer that set a sandbox ceiling: the platform (super admin), the organization (its
 * admins), the device (its own network choice), the owner of the machine it runs on (as its
 * provider reports it) or the provider.
 */
export type DeviceSandboxLayer = "platform" | "org" | "device" | "owner" | "provider";

/**
 * A device's sandbox in effect (kernel `DeviceSandboxView`, approval-only profiles design, "UI"),
 * the same under every permission profile.
 */
export interface DeviceSandboxView {
  network: DeviceNetworkMode;
  /** The widest network the platform, the org and the provider leave this device. */
  networkCeiling: DeviceNetworkMode;
  /** The allowlist hosts in effect (empty unless `network` is `allowlist`). */
  hosts: string[];
  /** The device's own network: its stored choice (null follows its org). */
  ownNetwork: DeviceNetworkMode | null;
  /** The device's own host list, which only narrows the org's (empty: it follows its org's hosts). */
  allowedDomains: string[];
  /** Whether a call may be granted running outside the sandbox (its provider decides it). */
  outsideSandbox: boolean;
  /** The layer that set each ceiling (a disabled option names it), null when nothing did. */
  layer: { network: DeviceSandboxLayer | null; outsideSandbox: DeviceSandboxLayer | null };
  /** A cloud device's instance runs another network: its next use applies this one. */
  pendingNextUse: boolean;
  /** Its provider applies limits at a file reset, so only that applies the new network. */
  pendingFilesReset: boolean;
  /** Its last setting changes, newest first. */
  recent: DeviceSettingChange[];
}

export interface Device {
  id: string;
  /**
   * null for the person's default device (shown as 个人设备 / "Personal"; english-comments-ok:
   * the zh UI label); see {@link deviceName}.
   */
  name: string | null;
  isDefault: boolean;
  ownerKind: "personal";
  /** The provider it is bound to for life. */
  provider: string | null;
  /** The provider's extension display name (also when the provider is off); null without one. */
  providerDisplayName: LocalizedName | null;
  /** Its provider serves its devices over the dial-in channel (a machine signs in to the device). */
  dialIn: boolean;
  /** Its provider serves the org now (on in the org). */
  available: boolean;
  /** What its provider last reported about it (the stored copy); null until a first one. */
  report: DeviceReport | null;
  /** A dial-in device: its machine is connected now; null for any other. */
  online: boolean | null;
  /**
   * A dial-in device's signed-in machine (its unrevoked one, whatever its connection); null for any
   * other, or when none is signed in.
   */
  machine: DeviceMachine | null;
  /** Its sandbox in effect (approval-only profiles design, "Settings model"). */
  sandbox: DeviceSandboxView;
  /**
   * A device whose sandbox limits must be established again: nothing runs on it until its files
   * are reset.
   */
  reconcileRequired: boolean;
  /** Its file system is gone at the provider; resetting the files makes it usable again. */
  filesLost: boolean;
  instance: { status: "running" | "suspended"; lastUsedAt: string } | null;
  limits: DeviceLimits;
  createdAt: string;
}

/** A text in English with an optional Chinese translation (a provider's words for people). */
export interface DeviceText {
  en: string;
  zh?: string;
}

/** What a device's provider told about it: shown as is, never used for enforcement. */
export interface DeviceReport {
  revision: string;
  description: DeviceText;
  home: string | null;
  limits: { label: DeviceText; value: string }[];
  reset: boolean;
  /** Who can change the device's limits and how, in its provider's words; absent when none. */
  changeHint?: DeviceText;
}

/** The text in the page language (English when it has no translation). */
export const deviceText = (t: DeviceText, locale: "zh" | "en"): string =>
  locale === "zh" ? (t.zh ?? t.en) : t.en;

/** A device provider a new device may be created on. */
export interface DeviceProviderOption {
  plugin: string;
  displayName: LocalizedName | null;
  description: DeviceText | null;
  dialIn: boolean;
  guide: SetupGuideRef | null;
}

export interface DeviceList {
  items: Device[];
  defaultId: string | null;
  lastUsedId: string | null;
  /** The device providers on in the org: a new device names one. */
  providers: DeviceProviderOption[];
  /** The provider a new device gets when it names none; null when there is none. */
  defaultProvider: string | null;
}

/**
 * What a device is doing, in the order the page decides: a missing provider wins; a dial-in
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
  if (e.filesLost) return "filesLost";
  if (e.online !== null) return e.online ? "online" : "offline";
  return e.instance?.status ?? "notStarted";
}

/** A device's provider for people: its display name in the page language, else the plugin name. */
export const providerLabel = (
  e: Pick<Device, "provider" | "providerDisplayName">,
  locale: "zh" | "en",
): string =>
  e.provider === null
    ? ""
    : extensionLabel({ name: e.provider, displayName: e.providerDisplayName }, locale);

/** How often the device page reads a device while a file reset it requested is pending. */
export const RESET_POLL_MS = 1500;
/** How long the page polls after a file reset at most: a marker that stays set never polls forever. */
export const RESET_POLL_DEADLINE_MS = 120_000;

/**
 * The device page's poll after a file reset (`startedAt`: when it was requested, null for none):
 * every {@link RESET_POLL_MS} while the files are lost, a change waits for the reset or the sandbox
 * limits must be established again, and never past {@link RESET_POLL_DEADLINE_MS}.
 */
export function resetPollInterval(
  d:
    | (Pick<Device, "filesLost" | "reconcileRequired"> & {
        sandbox: Pick<DeviceSandboxView, "pendingFilesReset">;
      })
    | undefined,
  startedAt: number | null,
  now: number,
): number | false {
  if (d === undefined || startedAt === null || now - startedAt >= RESET_POLL_DEADLINE_MS)
    return false;
  return d.filesLost || d.sandbox.pendingFilesReset || d.reconcileRequired ? RESET_POLL_MS : false;
}

/** A device's name for people: its own name, else the localized "Personal" for the default. */
export const deviceName = (e: Pick<Device, "name">, personal: string): string => e.name ?? personal;

/**
 * The one mark a device carries in lists, its page and a conversation's properties: whether a
 * call may be granted running outside its sandbox there (neutral), never a daily mode.
 */
export const deviceCeilingMark = (e: Pick<Device, "sandbox">): "outside" | "sandbox" =>
  e.sandbox.outsideSandbox ? "outside" : "sandbox";

/**
 * Whether a new conversation can be bound to it now: its provider is there, its files are not
 * lost and, for a dial-in device, its machine is online.
 */
export const devicePickable = (e: Device): boolean => {
  const state = deviceState(e);
  return state !== "unavailable" && state !== "filesLost" && state !== "offline";
};

/**
 * Whether the new conversation's device picker shows at all: a device provider is on in the org, or
 * the person has a device.
 */
export const deviceChoiceShown = (list: DeviceList): boolean =>
  list.providers.length > 0 || list.items.length > 0;

/**
 * The device a new conversation starts on (environments design §4.1 item 2): the one `picked`,
 * else the last used, else the default, else the first pickable one; never one that cannot be
 * picked now. Undefined when none can (or the picker is not shown). The route's prefetch of its
 * projects and the composer's picker share it.
 */
export function chosenDeviceId(list: DeviceList, picked: string | null = null): string | undefined {
  if (!deviceChoiceShown(list)) return undefined;
  const usable = (id: string | null | undefined) =>
    list.items.find((e) => e.id === id && devicePickable(e))?.id;
  return (
    usable(picked) ??
    usable(list.lastUsedId) ??
    usable(list.defaultId) ??
    list.items.find(devicePickable)?.id
  );
}

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

export const createDevice = (orgId: string, body: { name: string; provider: string }) =>
  apiFetch<{ device: Device }>(org(orgId), {
    method: "POST",
    body: JSON.stringify({ name: body.name.trim(), provider: body.provider }),
  });

export const renameDevice = (orgId: string, id: string, name: string) =>
  apiFetch<{ device: Device }>(`${org(orgId)}/${enc(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name: name.trim() }),
  });

export const deleteDevice = (orgId: string, id: string) =>
  apiFetch<void>(`${org(orgId)}/${enc(id)}`, { method: "DELETE" });

export const resetDeviceFiles = (orgId: string, id: string) =>
  apiFetch<void>(`${org(orgId)}/${enc(id)}/files/reset`, { method: "POST" });

/**
 * A device's network (`PATCH …/devices/:id`), by its owner only, in either direction within the
 * platform and org ceilings (`device.network_not_allowed` above them): `none` closes it, an
 * allowlist's hosts only narrow the organization's list (empty follows it), `mode: null` follows the
 * organization.
 */
export const setDeviceNetwork = (
  orgId: string,
  id: string,
  network: { mode: DeviceNetworkMode | null; hosts?: string[] },
) =>
  apiFetch<{ device: Device }>(`${org(orgId)}/${enc(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ network }),
  });

/** A project on a device (project root §4.1; kernel `DeviceProjectView`). */
export interface DeviceProject {
  name: string;
  /** The absolute path on the device. */
  path: string;
  createdAt: string;
}

/** `GET …/devices/:id/projects` (kernel `DeviceProjectList`). */
export interface DeviceProjectList {
  projects: DeviceProject[];
  /** The base a relative path is resolved against; null when it is not known. */
  base: string | null;
  /** The device offers projects (a machine announcing `projects`, a provider with list / scan). */
  supported: boolean;
}

/** One suggestion of `GET …/devices/:id/projects/candidates`. */
export interface DeviceProjectCandidate {
  path: string;
  /** `path` relative to the base (empty for the base itself): what the add form takes. */
  relativePath: string;
  suggestedName: string;
}

export interface DeviceProjectCandidates {
  candidates: DeviceProjectCandidate[];
  base: string | null;
  supported: boolean;
}

/**
 * The fixed prefix the add form shows before the relative path (project root §4.2): the base the
 * kernel returned (the provider-reported home, else the workspace), ending in one `/`.
 */
export const projectBasePrefix = (base: string): string => `${base.replace(/\/+$/, "")}/`;

/** The relative path as sent: trimmed, without a leading `./` or trailing slashes. */
export const normalizeProjectPath = (p: string): string =>
  p
    .trim()
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");

/** The name a project gets when none is typed: the last segment of its path (or of the base). */
export const defaultProjectName = (relative: string, base: string | null): string => {
  const seg = (s: string) =>
    s
      .split("/")
      .filter((x) => x !== "" && x !== ".")
      .at(-1) ?? "";
  return seg(normalizeProjectPath(relative)) || seg(base ?? "");
};

export const listDeviceProjects = (orgId: string, id: string) =>
  apiFetch<DeviceProjectList>(`${org(orgId)}/${enc(id)}/projects`);

/** Asks the device (`scan`): it starts or resumes it, so it is read only when the add form opens. */
export const listDeviceProjectCandidates = (orgId: string, id: string) =>
  apiFetch<DeviceProjectCandidates>(`${org(orgId)}/${enc(id)}/projects/candidates`);

export const addDeviceProject = (
  orgId: string,
  id: string,
  input: { path: string; name?: string },
) =>
  apiFetch<{ project: DeviceProject }>(`${org(orgId)}/${enc(id)}/projects`, {
    method: "POST",
    body: JSON.stringify(input),
  });

export const removeDeviceProject = (orgId: string, id: string, name: string) =>
  apiFetch<void>(`${org(orgId)}/${enc(id)}/projects/${enc(name)}`, { method: "DELETE" });
