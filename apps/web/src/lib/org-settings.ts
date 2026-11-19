import { apiFetch } from "./api";
import type { CompactionSettings, CompactionSettingsPatch } from "./compaction";
import type { ScheduledTasksSettings } from "./schedules";
import type { UiArrangementEntry } from "./ui";

/** A device sandbox network: the open public internet (private networks blocked) or an allowlist. */
export type DeviceNetworkMode = "open" | "allowlist";

/**
 * The org's stored device network (approval-only profiles design, "Settings model"; kernel
 * `DeviceNetworkSettingSchema`), for local and cloud devices alike; every field optional (absent
 * follows the platform):
 * - `default`: the network a device gets when its owner chooses none;
 * - `ceiling`: the widest network a device of the org may choose (never above the platform's; a
 *   default never above the ceiling);
 * - `base`: `platform` (absent: the platform's `sandbox.limits.allowHosts` minus `excludedHosts`)
 *   or `none` (only `extraHosts`);
 * - `extraHosts`: hosts the org adds; `excludedHosts`: platform entries the org drops (base
 *   platform only; may name entries the platform dropped since).
 */
export interface DeviceNetworkSetting {
  default?: DeviceNetworkMode;
  ceiling?: DeviceNetworkMode;
  base?: "platform" | "none";
  extraHosts?: string[];
  excludedHosts?: string[];
}

/**
 * The org's effective allowlist network (kernel `OrgEffectiveNetwork`): `allowlist` when the kill
 * switch, the platform host ceiling or the org's own default or ceiling says so, and the hosts
 * (platform list with the org's delta applied; empty under the kill switch).
 */
export interface OrgEffectiveNetwork {
  mode: DeviceNetworkMode;
  hosts: string[];
}

/** Where a platform device sandbox setting comes from (kernel `DeviceSandboxSource`). */
export type DeviceSandboxSource = "env" | "file" | "nacos" | "db" | "default";

/** Whether a startup config source makes a platform setting read-only in the console. */
export const lockedSource = (source: DeviceSandboxSource | undefined): boolean =>
  source === "env" || source === "file" || source === "nacos";

/** The platform's outside-sandbox ceiling in effect (kernel `DevicesOutsideSandboxView`). */
export interface DevicesOutsideSandboxView {
  /** `allowed`: a call may be granted running outside the sandbox where the org and owner allow it. */
  permission: "allowed" | "off";
  /** `env` / `file` / `nacos` are the startup config (read-only); `db` the admin console; `default`. */
  source: DeviceSandboxSource;
}

/** The platform's device network in effect (kernel `DevicesNetworkView`): the default within the ceiling. */
export interface DevicesNetworkView {
  default: DeviceNetworkMode;
  ceiling: DeviceNetworkMode;
  sources: { default: DeviceSandboxSource; ceiling: DeviceSandboxSource };
}

/** The narrower of two networks (`allowlist` is narrower than `open`). */
export const narrowerNetwork = (a: DeviceNetworkMode, b: DeviceNetworkMode): DeviceNetworkMode =>
  a === "allowlist" || b === "allowlist" ? "allowlist" : "open";

/**
 * 组织设置（`packages/kernel/src/orgs/settings.controller.ts`）：成员可读，管理员可改。
 * - `toolSearch`：工具很多时改用目录 + `ToolSearch` 按需加载（默认 on）；
 * - `locale`：组织默认语言（默认 en），机器人在 IM 里说的固定话术按它选择；
 * - `sandboxToolPolicy`：沙箱工具的默认策略（默认 allow；ask 时除只读工具外都要审批）；
 * - `outsideSandbox`: whether a call on the org's devices may be granted running outside the
 *   sandbox; absent follows the platform;
 * - `deviceNetwork`: the org's device network (default, ceiling and hosts as a delta over the
 *   platform's list); absent follows the platform;
 * - `platformTool`: the `Platform` builtin for the whole org (`on` / `read-only` / `off`, default on).
 */
export interface OrgSettings {
  toolSearch: "on" | "off";
  locale: "zh" | "en";
  /** 旧内核没有这个字段：缺省按 allow。 */
  sandboxToolPolicy?: "allow" | "ask";
  /** The org's outside-sandbox ceiling; absent = follow the platform. */
  outsideSandbox?: "allowed" | "off";
  /** The org's device network; absent = follow the platform. */
  deviceNetwork?: DeviceNetworkSetting;
  platformTool: "on" | "read-only" | "off";
  /** The org's default time zone (IANA) for senders without one of their own; absent = UTC. */
  timeZone?: string;
  /**
   * The org's default theme (null: follow the platform) and whether members may pick their own
   * (themes spec §7); absent: follow the platform, allowed.
   */
  theme?: OrgThemeSetting;
  /** Scheduled tasks (scheduled tasks spec §9). */
  scheduledTasks: ScheduledTasksSettings;
  /**
   * The organization's conversation compaction overrides (context compaction spec §4.8); absent
   * follows the platform.
   */
  compaction?: CompactionSettingsPatch;
  /**
   * Whether members may share conversation files with anyone who has the link (file sharing spec
   * §8); absent = off. Turning it on needs the platform to allow it.
   */
  externalSharing?: "on" | "off";
  /**
   * Prompt suggestions after a completed run (prompt suggestions spec §6); absent = on (following
   * the platform). The org cannot turn on what the platform turned off.
   */
  promptSuggestions?: "on" | "off";
}

/** The org level of the themes (`orgs.settings.theme`). */
export interface OrgThemeSetting {
  id: string | null;
  personal: "allowed" | "locked";
}

/** The deployment defaults the settings page shows for "follow the platform". */
export interface OrgSettingsDeployment {
  /** The platform's outside-sandbox ceiling and where it comes from. */
  outsideSandbox: DevicesOutsideSandboxView;
  /**
   * The platform's device network: its default and ceiling with their sources, its allowlist
   * (what an org's delta applies to), whether orgs may go beyond it (`orgHosts`,
   * `sandbox.limits.orgHosts`: `within` keeps the hosts within the list) and the kill switch
   * (`off`: `sandbox.limits.egress` is `none`).
   */
  deviceNetwork: DevicesNetworkView & {
    allowHosts: string[];
    orgHosts: "extend" | "within";
    off: boolean;
  };
  /**
   * The platform's effective attribution defaults for agent-created commits and pull requests
   * (spec 2026-11-14-agent-attribution).
   */
  attribution: { commit: string; pr: string; sessionUrl: boolean };
  /**
   * Whether the deployment set `http.publicUrl`. Without it no conversation link is added to a pull
   * request, so the agent page can say why the link setting has no effect.
   */
  publicUrl: boolean;
  /** The platform's conversation compaction settings. */
  compaction: CompactionSettings;
  /** The platform's external sharing switch (`deny`: the org cannot turn it on) and its source. */
  externalSharing?: {
    value: "allow" | "deny";
    source: "env" | "file" | "nacos" | "db" | "default";
  };
  /** The longest expiry a share may take, in days. */
  shareMaxExpiryDays?: number;
  /** The platform's prompt suggestion switch (`off`: the org's switch is off and locked). */
  promptSuggestions?: "on" | "off";
}

/** 组织实际生效的沙箱 cpu / 内存（只读：超级管理员在部署设置里按组织覆盖；旧内核不返回）。 */
export interface OrgSandboxLimits {
  cpu: number;
  memoryMb: number;
  source: "deployment" | "override";
}

export interface OrgSettingsResponse {
  settings: OrgSettings;
  deployment?: OrgSettingsDeployment;
  sandboxLimits?: OrgSandboxLimits;
  /** The org's effective device network (the kernel always sends it; optional for the cache merge). */
  effectiveNetwork?: OrgEffectiveNetwork;
}

/** The PATCH body: `deviceNetwork: null` follows the platform again. */
export type OrgSettingsPatch = Partial<
  Omit<
    OrgSettings,
    | "outsideSandbox"
    | "deviceNetwork"
    | "timeZone"
    | "theme"
    | "scheduledTasks"
    | "compaction"
    | "promptSuggestions"
  >
> & {
  /** The scheduled-task fields to change; the rest keep their value. */
  scheduledTasks?: Partial<ScheduledTasksSettings>;
  /** null clears the theme setting (follow the platform, allowed). */
  theme?: OrgThemeSetting | null;
  /** null clears it (follow the platform). */
  outsideSandbox?: "allowed" | "off" | null;
  /** Replaces the stored value whole (send it with the edited fields); null follows the platform. */
  deviceNetwork?: DeviceNetworkSetting | null;
  /** null clears the default (UTC). */
  timeZone?: string | null;
  /** Per slot: the entry replaces the org's, null removes it (follow the platform). */
  uiArrangement?: Record<string, UiArrangementEntry | null>;
  /** The fields to override; null clears the whole override (follow the platform again). */
  compaction?: CompactionSettingsPatch | null;
  /** null clears it (on again, following the platform). */
  promptSuggestions?: "on" | "off" | null;
};

const path = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/settings`;

export const getOrgSettings = (orgId: string) => apiFetch<OrgSettingsResponse>(path(orgId));

export const updateOrgSettings = (orgId: string, patch: OrgSettingsPatch) =>
  apiFetch<OrgSettingsResponse>(path(orgId), {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

/**
 * The value to PATCH when the settings page saves the device network: the stored value whole with
 * the edited fields changed. `default` and `ceiling` stay the stored ones (absent stays absent)
 * unless `modes` gives them; `base` stays the stored one. With base platform the edited list
 * `edited` becomes `extraHosts = edited − platform` and `excludedHosts = (platform − edited) ∪
 * (stored exclusions − platform)` (an exclusion of an entry the platform dropped survives in case it
 * comes back); with base none `extraHosts = edited`. Empty lists are left out.
 */
export function deviceNetworkToSave(
  stored: DeviceNetworkSetting | undefined,
  platformHosts: readonly string[],
  edited: readonly string[],
  modes: { default?: DeviceNetworkMode; ceiling?: DeviceNetworkMode } = {},
): DeviceNetworkSetting {
  const value: DeviceNetworkSetting = {};
  const def = modes.default ?? stored?.default;
  const ceiling = modes.ceiling ?? stored?.ceiling;
  if (def !== undefined) value.default = def;
  if (ceiling !== undefined) value.ceiling = ceiling;
  if (stored?.base !== undefined) value.base = stored.base;
  if (stored?.base === "none") {
    if (edited.length > 0) value.extraHosts = [...edited];
    return value;
  }
  const platform = new Set(platformHosts);
  const kept = new Set(edited);
  // an extra the org stored is kept while the list holds it, even when the platform lists it too
  // now: the org keeps it when the platform drops it later
  const storedExtra = new Set(stored?.extraHosts ?? []);
  const extra = edited.filter((h) => !platform.has(h) || storedExtra.has(h));
  const excluded = [
    ...new Set([
      ...platformHosts.filter((h) => !kept.has(h)),
      ...(stored?.excludedHosts ?? []).filter((h) => !platform.has(h)),
    ]),
  ];
  if (extra.length > 0) value.extraHosts = extra;
  if (excluded.length > 0) value.excludedHosts = excluded;
  return value;
}

/** 主机清单文本（每行一个）→ 去空白、转小写、去空行、去重后的数组。 */
export function parseHostList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h !== ""),
    ),
  ];
}

/** 能否修改组织设置（`org.update`：管理员起；只用于界面，最终由内核判定）。 */
export function canUpdateOrg(me: {
  currentOrgId: string | null;
  memberships: { orgId: string; role: string }[];
}): boolean {
  const role = me.memberships.find((m) => m.orgId === me.currentOrgId)?.role;
  return role === "admin" || role === "owner";
}

/**
 * Whether `me` may change an agent: its owner (members up: `agents.create`) or an org admin (R3).
 * The kernel stays the authority on every save.
 */
export function canEditAgent(
  me: {
    account: { id: string };
    currentOrgId: string | null;
    memberships: { orgId: string; role: string }[];
  },
  agent: { ownerAccountId: string },
): boolean {
  const role = me.memberships.find((m) => m.orgId === me.currentOrgId)?.role;
  if (role !== "member" && role !== "admin" && role !== "owner") return false;
  return agent.ownerAccountId === me.account.id || canUpdateOrg(me);
}
