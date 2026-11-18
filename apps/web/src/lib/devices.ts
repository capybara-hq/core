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
  /** The mode the limits were made with. Mirrored from the kernel view; the web reads it nowhere. */
  mode: DeviceMode;
  /**
   * `open-public` for a cloud device in auto mode; the allowlist in sandbox mode. Mirrored from the
   * kernel view; the web reads `mode.network` (the effective network) instead.
   */
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
  fullAccess: boolean;
  /** A machine's restricted project reach; a cloud device's change has none. */
  restrictedProjectReach?: "workspace" | "os-user";
}

/** One mode, policy or ceiling change of a device (kernel `DeviceModeChangeView`), newest first. */
export interface DeviceModeChange {
  at: string;
  /**
   * `policy`: a local allowlist change; `mode`: the device switched between auto and sandbox;
   * `ceiling`: its owner ceiling changed (a cloud device's Full ceiling, or a machine's report).
   */
  kind: "policy" | "mode" | "ceiling";
  add: string[];
  remove: string[];
  /**
   * The mode change (`from` only for a change made on the machine); null when it did not change.
   */
  mode: { from?: DeviceMode | null; to: DeviceMode } | null;
  /** The ceiling change (`ceiling` rows only; `from` null when unknown); else null. */
  ceiling: { from: DeviceCeilingChangeSide | null; to: DeviceCeilingChangeSide } | null;
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
  /**
   * A cloud device: the network it reaches with Full access off (the org's cloud network, open by
   * default) within its outer network, whatever mode it runs at now; null for a local device.
   */
  sandboxNetwork: { kind: DeviceNetworkKind; hosts: string[] } | null;
  /** A cloud device: the network it reaches with Full access within its outer network; null for local. */
  fullNetwork: { kind: DeviceNetworkKind; hosts: string[] } | null;
  /** A cloud device's outer network, which no change widens; null for local or not migrated. */
  outerNetwork: { kind: DeviceNetworkKind; hosts: string[] } | null;
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
  /** Its owner ceiling (read only); null for a local device without a machine or a cloud one not migrated. */
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
        mode: Pick<DeviceModeView, "pendingFilesReset">;
      })
    | undefined,
  startedAt: number | null,
  now: number,
): number | false {
  if (d === undefined || startedAt === null || now - startedAt >= RESET_POLL_DEADLINE_MS)
    return false;
  return d.filesLost || d.mode.pendingFilesReset || d.reconcileRequired ? RESET_POLL_MS : false;
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
 * local machine's authenticated owner report (`report`), a stale or conflicting one (`blocked`),
 * only an older program's mode summary (`legacy`) or nothing readable (`missing`); a cloud device's
 * explicit Full ceiling (`cloud`) once its permissions were migrated.
 */
export interface DeviceOwnerCeiling {
  state: "report" | "blocked" | "legacy" | "missing" | "cloud";
  revision: string | null;
  sequence: number | null;
  /** The owner's ceiling as stored or reported (a cloud device: before its old sandbox switch). */
  fullAccess: boolean;
  /**
   * Whether the owner's side allows Full access as the kernel applies it (a cloud device's ceiling
   * narrowed by its old sandbox switch); the platform and the org may still cut it.
   */
  effectiveFullAccess: boolean;
  /** How far restricted (non-Full) work and project browsing reach; a cloud device: `workspace`. */
  restrictedProjectReach: "workspace" | "os-user";
  restrictedAllowedDomains: string[];
  observedAt: string | null;
  /** The machine is offline or its report is not current: last-known facts, not authority. */
  stale: boolean;
}

/**
 * Whether Full access can be chosen on a device now, and why not: `owner`, its owner's ceiling has
 * it off; `platform`, the platform or the org does not allow it; `unconfirmed`, a local machine
 * has no usable owner report (none connected, a blocked or missing report).
 */
export type DeviceFullAccess = "available" | "owner" | "platform" | "unconfirmed";

/** What the device page says about the ceiling's facts, when anything (one notice at a time). */
export type DeviceCeilingNotice =
  | "noMachine"
  | "blocked"
  | "missing"
  | "legacy"
  | "stale"
  | "migrating";

export interface DeviceCeilingFacts {
  full: DeviceFullAccess;
  /** The owner's own ceiling allows Full access (before the platform and the org cut it). */
  ownerAllows: boolean;
  /** Restricted work's project reach; null when unknown (no usable report). */
  reach: "workspace" | "os-user" | null;
  notice: DeviceCeilingNotice | null;
}

/**
 * The ceiling facts of a device (permission profiles spec, "Device and execution model"): the
 * owner's ceiling cut by what the platform and the org allow. A local machine fails closed while
 * its report is blocked or missing; a cloud device not migrated yet follows its old narrowing.
 */
export function deviceCeilingOf(
  e: Pick<Device, "source" | "machine" | "mode" | "ownerCeiling">,
): DeviceCeilingFacts {
  const allowed = e.mode.allowedMode === "auto";
  const c = e.ownerCeiling ?? null;
  const cut = (ownerAllows: boolean): DeviceFullAccess =>
    !ownerAllows ? "owner" : !allowed ? "platform" : "available";
  if (e.source === "cloud") {
    // a migrated device: the kernel's effective owner allowance (its ceiling cut by an old
    // sandbox switch); before the migration only that switch narrows, seen while auto is allowed
    const ownerAllows =
      c === null ? !(e.mode.mode === "sandbox" && allowed) : c.effectiveFullAccess;
    return {
      full: cut(ownerAllows),
      ownerAllows,
      reach: "workspace",
      notice: c === null ? "migrating" : null,
    };
  }
  if (c === null) {
    return {
      full: "unconfirmed",
      ownerAllows: false,
      reach: null,
      notice: e.machine === null ? "noMachine" : "missing",
    };
  }
  if (c.state === "blocked" || c.state === "missing") {
    return { full: "unconfirmed", ownerAllows: false, reach: null, notice: c.state };
  }
  return {
    full: cut(c.fullAccess),
    ownerAllows: c.fullAccess,
    reach: c.restrictedProjectReach,
    notice: c.state === "legacy" ? "legacy" : c.stale ? "stale" : null,
  };
}

/**
 * The one mark a device carries in lists, its page and a conversation's properties: whether Full
 * access is available there (neutral, like every permission choice), never a daily mode.
 */
export const deviceCeilingMark = (
  e: Pick<Device, "source" | "machine" | "mode" | "ownerCeiling">,
): "full" | "restricted" => (deviceCeilingOf(e).full === "available" ? "full" : "restricted");

/** A change of a local device's policy by its owner (`POST …/devices/:id/policy`). */
export interface DevicePolicyPatch {
  /** Hosts to allow (wildcards `*.` allowed); at most {@link MAX_POLICY_HOSTS}. */
  add?: string[];
  remove?: string[];
  /**
   * An older program's (protocol 2) narrowing: it turns Full access off and limits the project
   * reach to the workspace at once. Never anything wider.
   */
  mode?: "sandbox";
  /** Narrowing only: the web never widens a machine's ceiling (`capybara-device ceiling set`). */
  ownerCeiling?: { fullAccess?: false; restrictedProjectReach?: "workspace" };
}

/** The most hosts one policy change adds. */
export const MAX_POLICY_HOSTS = 20;

/**
 * Turns Full access off on a cloud device (`PATCH …/devices/:id`): its explicit ceiling once the
 * device's permissions were migrated, else the old narrowing switch the kernel still takes then.
 */
export const narrowCloudDevice = (orgId: string, id: string, migrated: boolean) =>
  apiFetch<{ device: Device }>(`${org(orgId)}/${enc(id)}`, {
    method: "PATCH",
    body: JSON.stringify(migrated ? { ownerCeiling: { fullAccess: false } } : { mode: "sandbox" }),
  });

/**
 * Allows Full access on a migrated cloud device: only sent from the confirmation that names its
 * effect, so it always carries `confirmWidening` (the kernel refuses a widening without it).
 */
export const widenCloudDevice = (orgId: string, id: string) =>
  apiFetch<{ device: Device }>(`${org(orgId)}/${enc(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ ownerCeiling: { fullAccess: true }, confirmWidening: true }),
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
