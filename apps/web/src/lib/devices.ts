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
  /** Mirrored from the kernel view; the web reads `sandbox` (the effective network) instead. */
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
 * A local device's policy as its machine last reported it (kernel `DeviceLocalPolicySummary`).
 */
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

/** One side of an owner ceiling change (kernel `DeviceCeilingFacts`). */
export interface DeviceCeilingChangeSide {
  outsideSandbox: boolean;
  /** A machine's restricted project reach, when the row records it. */
  restrictedProjectReach?: "workspace" | "os-user";
  /** The owner's sandbox network, when the row records it. */
  network?: "open" | "allowlist";
}

/** A cloud device's stored network (kernel `DeviceNetworkSetting`): `mode` null follows its org. */
export interface DeviceNetworkSetting {
  mode: DeviceNetworkMode | null;
  hosts: string[];
}

/** One setting change of a device (kernel `DeviceSettingChangeView`), newest first. */
export interface DeviceSettingChange {
  at: string;
  /**
   * `policy`: a local allowlist change; `ceiling`: a machine's owner ceiling changed; `network`: a
   * cloud device's network changed.
   */
  kind: "policy" | "ceiling" | "network";
  add: string[];
  remove: string[];
  /** The owner ceiling change (`ceiling` rows only; `from` null when unknown); else null. */
  ceiling: { from: DeviceCeilingChangeSide | null; to: DeviceCeilingChangeSide } | null;
  /** The cloud network change (`network` rows only); else null. */
  network: { from: DeviceNetworkSetting; to: DeviceNetworkSetting } | null;
  /** The deciding account's display name (null once the account is gone). */
  by: string | null;
  /**
   * `device`: made or reported on the machine itself; `agent`: an agent's Platform tool call;
   * `token`: an API token.
   */
  via: "web" | "im" | "device" | "agent" | "token";
  /**
   * What became of a change sent to the machine: `unknown`, its answer never came; `failed`, it
   * did not take effect. Every other row is `applied`.
   */
  outcome: "applied" | "unknown" | "failed";
}

/** A device sandbox network: the open internet (private networks blocked), an allowlist or closed. */
export type DeviceNetworkMode = "open" | "allowlist" | "none";

/**
 * The layer that set a sandbox ceiling: the platform (super admin), the organization (its
 * admins), the device (its owner on the machine, or a cloud device's own choice) or the provider.
 */
export type DeviceSandboxLayer = "platform" | "org" | "device" | "provider";

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
  /**
   * The device's own network: a cloud device's stored choice (null follows its org), a local
   * owner's reported one (null without a readable report).
   */
  ownNetwork: DeviceNetworkMode | null;
  /**
   * The device's own host list, which only narrows the org's: a local owner's `allowedDomains`, a
   * cloud device's stored hosts (empty: it follows its org's hosts).
   */
  allowedDomains: string[];
  /** Whether a call may be granted running outside the sandbox (never on a cloud device). */
  outsideSandbox: boolean;
  restrictedProjectReach: "workspace" | "os-user";
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
   * the zh UI label) and for a former default (shown from `demotedFrom`); see {@link deviceName}.
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
  /** Its sandbox in effect (approval-only profiles design, "Settings model"). */
  sandbox: DeviceSandboxView;
  /** A local machine's owner ceiling (read only); null for a cloud device or none connected. */
  ownerCeiling: DeviceOwnerCeiling | null;
  /**
   * A cloud device whose sandbox limits must be established again: nothing runs on it until its
   * files are rebuilt. Always false for a local device.
   */
  reconcileRequired: boolean;
  /** Mirrored from the kernel view; isolation is gone from the device page, the web reads it nowhere. */
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

/**
 * Whether the new conversation's device picker shows at all: the platform has a cloud sandbox, or
 * the person has a local device.
 */
export const deviceChoiceShown = (list: DeviceList): boolean =>
  list.cloudAvailable || list.items.some((e) => e.source === "local");

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
 * The owner ceiling of a device as last reported (kernel `DeviceOwnerCeilingView`, read only): a
 * local machine's authenticated owner report (`report`), a stale or conflicting one (`blocked`) or
 * nothing readable (`missing`). A cloud device has none.
 */
export interface DeviceOwnerCeiling {
  state: "report" | "blocked" | "missing";
  revision: string | null;
  sequence: number | null;
  /** The owner allows granting a call running outside the sandbox (fail closed: false). */
  outsideSandbox: boolean;
  /** The owner's sandbox network (fail closed: `allowlist`). */
  network: "open" | "allowlist";
  /** The owner's allowlist: under `allowlist` the machine's host ceiling. */
  allowedDomains: string[];
  /** How far project browsing and work reach. */
  restrictedProjectReach: "workspace" | "os-user";
  observedAt: string | null;
  /** The machine is offline or its report is not current: last-known facts, not authority. */
  stale: boolean;
}

/** What the device page says about the sandbox facts, when anything (one notice at a time). */
export type DeviceCeilingNotice = "noMachine" | "blocked" | "missing" | "stale";

export interface DeviceCeilingFacts {
  /** The sandbox in effect; null for a local machine without a usable report (fails closed). */
  sandbox: DeviceSandboxView | null;
  /** The owner's own ceiling (a local machine's report), null when unknown or cloud. */
  owner: DeviceOwnerCeiling | null;
  /** Project reach; null when unknown (no usable report). */
  reach: "workspace" | "os-user" | null;
  notice: DeviceCeilingNotice | null;
}

/**
 * A device's sandbox in effect (the kernel's `sandbox` view); null for a local machine without a
 * usable owner report (none, blocked or missing), which fails closed.
 */
export function deviceSandboxOf(
  e: Pick<Device, "source" | "ownerCeiling" | "sandbox">,
): DeviceSandboxView | null {
  if (e.source === "cloud") return e.sandbox ?? null;
  const c = e.ownerCeiling ?? null;
  if (c === null || c.state === "blocked" || c.state === "missing") return null;
  return e.sandbox ?? null;
}

/**
 * The sandbox facts of a device (approval-only profiles design, "UI"): its sandbox in effect, a
 * local machine's own ceiling and project reach, and one notice when the facts are not current.
 * A local machine fails closed while its report is blocked or missing.
 */
export function deviceCeilingOf(
  e: Pick<Device, "source" | "machine" | "ownerCeiling" | "sandbox">,
): DeviceCeilingFacts {
  const c = e.ownerCeiling ?? null;
  const sandbox = deviceSandboxOf(e);
  if (e.source === "cloud") return { sandbox, owner: null, reach: "workspace", notice: null };
  if (c === null)
    return {
      sandbox: null,
      owner: null,
      reach: null,
      notice: e.machine === null ? "noMachine" : "missing",
    };
  if (c.state === "blocked" || c.state === "missing")
    return { sandbox: null, owner: null, reach: null, notice: c.state };
  return {
    sandbox,
    owner: c,
    reach: c.restrictedProjectReach,
    notice: c.stale ? "stale" : null,
  };
}

/**
 * The one mark a device carries in lists, its page and a conversation's properties: whether a
 * call may be granted running outside its sandbox there (neutral), never a daily mode.
 */
export const deviceCeilingMark = (
  e: Pick<Device, "source" | "machine" | "ownerCeiling" | "sandbox">,
): "outside" | "sandbox" =>
  deviceCeilingOf(e).sandbox?.outsideSandbox === true ? "outside" : "sandbox";

/**
 * A narrowing of a local machine's ceiling by its owner in a web session (`POST …/devices/:id/policy`,
 * the device protocol's `DeviceOwnerCeilingNarrowing`): the web never widens a machine (its owner
 * does, on the machine, with `capybara-device ceiling set` / `policy add`).
 */
export interface DevicePolicyPatch {
  /** Hosts to remove from the machine's allowlist. */
  remove?: string[];
  ownerCeiling?: {
    outsideSandbox?: false;
    network?: "allowlist";
    restrictedProjectReach?: "workspace";
  };
}

/**
 * A cloud device's network (`PATCH …/devices/:id`), by its owner only, in either direction within
 * the platform and org ceilings (`device.network_not_allowed` above them): `none` closes it, an
 * allowlist's hosts only narrow the organization's list (empty follows it), `mode: null` follows the
 * organization. A local device refuses it (`device.ceiling_on_machine`).
 */
export const setCloudDeviceNetwork = (
  orgId: string,
  id: string,
  network: { mode: DeviceNetworkMode | null; hosts?: string[] },
) =>
  apiFetch<{ device: Device }>(`${org(orgId)}/${enc(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ network }),
  });

/** Sent to the machine, which writes it and answers with the policy as written. */
export const updateDevicePolicy = (orgId: string, id: string, patch: DevicePolicyPatch) =>
  apiFetch<{ policy: DeviceNetworkPolicy }>(`${org(orgId)}/${enc(id)}/policy`, {
    method: "POST",
    body: JSON.stringify(patch),
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
  /** The projects the device's current mode can read. */
  projects: DeviceProject[];
  /** How many stored projects the current mode hides (kept, not deleted). */
  hidden: number;
  /** The mode the device runs at now: it decides the base a relative path is read against. */
  mode: DeviceMode;
  /**
   * The base a relative path is resolved against: the workspace in sandbox mode and on a cloud
   * device, the owner's home in auto mode; null when that home is not known.
   */
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
  mode: DeviceMode;
  base: string | null;
  supported: boolean;
}

/**
 * The fixed prefix the add form shows before the relative path (project root §4.2): the owner's
 * home (`~/`) for a local device in auto mode, else the workspace (`workspace/`, also every cloud
 * device in either mode).
 */
export const projectBasePrefix = (source: Device["source"], mode: DeviceMode): string =>
  source === "local" && mode === "auto" ? "~/" : "workspace/";

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
