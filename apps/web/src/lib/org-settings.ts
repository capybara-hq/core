import { apiFetch } from "./api";
import type { ScheduledTasksSettings } from "./schedules";
import type { UiArrangementEntry } from "./ui";

/**
 * The org's network for cloud devices in sandbox mode (auto mode spec §4.3): `open` (any public
 * host; loopback, private and cloud metadata addresses are blocked outside the container) or
 * `allowlist` with `allowHosts`. `allowHosts` given replaces the platform's list (the org may drop
 * the presets and add its own); omitted, the platform's `sandbox.limits.allowHosts` applies.
 */
export interface CloudNetworkSetting {
  mode: "open" | "allowlist";
  allowHosts?: string[];
}

/** Where the platform's auto-mode switch comes from (kernel `DevicesAutoModeSource`). */
export type DevicesAutoModeSource = "env" | "file" | "nacos" | "db" | "default";

/** The platform's auto-mode switch in effect (kernel `DevicesAutoModeView`). */
export interface DevicesAutoModeView {
  /** `allowed`: devices in the org may run in auto mode when the org allows it. */
  mode: "allowed" | "off";
  /** `env` / `file` / `nacos` are the startup config (read-only); `db` the admin console; `default`. */
  source: DevicesAutoModeSource;
}

/**
 * 组织设置（`packages/kernel/src/orgs/settings.controller.ts`）：成员可读，管理员可改。
 * - `toolSearch`：工具很多时改用目录 + `ToolSearch` 按需加载（默认 on）；
 * - `locale`：组织默认语言（默认 en），机器人在 IM 里说的固定话术按它选择；
 * - `sandboxToolPolicy`：沙箱工具的默认策略（默认 allow；ask 时除只读工具外都要审批）；
 * - `autoMode`: whether the org's devices may run in auto mode (auto mode spec §4.3); absent
 *   follows the platform's switch;
 * - `cloudNetwork`: the network of the org's cloud devices in sandbox mode; absent follows the
 *   platform's default;
 * - `platformTool`: the `Platform` builtin for the whole org (`on` / `read-only` / `off`, default on).
 */
export interface OrgSettings {
  toolSearch: "on" | "off";
  locale: "zh" | "en";
  /** 旧内核没有这个字段：缺省按 allow。 */
  sandboxToolPolicy?: "allow" | "ask";
  /** The org's auto-mode switch; absent = follow the platform. */
  autoMode?: "allowed" | "off";
  /** The org's cloud-device network in sandbox mode; absent = follow the platform. */
  cloudNetwork?: CloudNetworkSetting;
  /** An older kernel leaves it out: read as on. */
  platformTool?: "on" | "read-only" | "off";
  /** The org's default time zone (IANA) for senders without one of their own; absent = UTC. */
  timeZone?: string;
  /**
   * The org's default theme (null: follow the platform) and whether members may pick their own
   * (themes spec §7); absent: follow the platform, allowed.
   */
  theme?: OrgThemeSetting;
  /** Scheduled tasks (scheduled tasks spec §9); an older kernel leaves it out (the defaults). */
  scheduledTasks?: ScheduledTasksSettings;
}

/** The org level of the themes (`orgs.settings.theme`). */
export interface OrgThemeSetting {
  id: string | null;
  personal: "allowed" | "locked";
}

/** The deployment defaults the settings page shows for "follow the platform". */
export interface OrgSettingsDeployment {
  /** The platform's auto-mode switch and where it comes from. */
  autoMode: DevicesAutoModeView;
  /**
   * The platform's default cloud network: `open` (the normal default; `allowlist` when
   * `sandbox.limits.egress` is `none`, the platform's kill switch) and the host list an allowlist
   * starts from.
   */
  cloudNetwork: { mode: "open" | "allowlist"; allowHosts: string[] };
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
}

/** PATCH 体：`cloudNetwork: null` 恢复跟随部署默认。 */
export type OrgSettingsPatch = Partial<
  Omit<OrgSettings, "autoMode" | "cloudNetwork" | "timeZone" | "theme" | "scheduledTasks">
> & {
  /** The scheduled-task fields to change; the rest keep their value. */
  scheduledTasks?: Partial<ScheduledTasksSettings>;
  /** null clears the theme setting (follow the platform, allowed). */
  theme?: OrgThemeSetting | null;
  /** null clears it (follow the platform). */
  autoMode?: "allowed" | "off" | null;
  /** null clears it (follow the platform's default). */
  cloudNetwork?: CloudNetworkSetting | null;
  /** null clears the default (UTC). */
  timeZone?: string | null;
  /** Per slot: the entry replaces the org's, null removes it (follow the platform). */
  uiArrangement?: Record<string, UiArrangementEntry | null>;
};

const path = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/settings`;

export const getOrgSettings = (orgId: string) => apiFetch<OrgSettingsResponse>(path(orgId));

export const updateOrgSettings = (orgId: string, patch: OrgSettingsPatch) =>
  apiFetch<OrgSettingsResponse>(path(orgId), {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

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
