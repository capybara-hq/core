import { apiFetch } from "./api";
import type { CompactionSettings, CompactionSettingsPatch } from "./compaction";
import type { SandboxTier } from "./devices";
import type { ScheduledTasksSettings } from "./schedules";
import type { UiArrangementEntry } from "./ui";

/** 组织的沙箱出站（Ruling M19）：`allowHosts` 给出时替换部署的白名单，省略时沿用部署的。 */
export interface SandboxEgressSetting {
  mode: "none" | "allowlist";
  allowHosts?: string[];
}

/**
 * The org's sandbox levels (sandbox dev tiers spec §4.1): `max` the highest level its devices may
 * reach, `default` the level of a device that chose none, `allowUnsandboxed` whether members'
 * devices may run without a sandbox. Each absent = follow the platform.
 */
export interface SandboxTierSetting {
  max?: SandboxTier;
  default?: SandboxTier;
  allowUnsandboxed?: boolean;
}

/**
 * 组织设置（`packages/kernel/src/orgs/settings.controller.ts`）：成员可读，管理员可改。
 * - `toolSearch`：工具很多时改用目录 + `ToolSearch` 按需加载（默认 on）；
 * - `locale`：组织默认语言（默认 en），机器人在 IM 里说的固定话术按它选择；
 * - `sandboxToolPolicy`：沙箱工具的默认策略（默认 allow；ask 时除只读工具外都要审批）；
 * - `sandboxEgress`：沙箱出站，缺省跟随部署默认（`deployment.sandboxEgress`）；
 * - `platformTool`: the `Platform` builtin for the whole org (`on` / `read-only` / `off`, default on).
 */
export interface OrgSettings {
  toolSearch: "on" | "off";
  locale: "zh" | "en";
  /** 旧内核没有这个字段：缺省按 allow。 */
  sandboxToolPolicy?: "allow" | "ask";
  sandboxEgress?: SandboxEgressSetting;
  /** The org's sandbox levels; absent = follow the platform. */
  sandboxTier?: SandboxTierSetting;
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
  /**
   * The organization's conversation compaction overrides (context compaction spec §4.8); absent
   * follows the platform. An older kernel leaves it out too.
   */
  compaction?: CompactionSettingsPatch;
}

/** The org level of the themes (`orgs.settings.theme`). */
export interface OrgThemeSetting {
  id: string | null;
  personal: "allowed" | "locked";
}

/** 部署默认值（旧内核不返回）。 */
export interface OrgSettingsDeployment {
  sandboxEgress: { mode: "none" | "allowlist"; allowHosts: string[] };
  /** The platform's sandbox levels and the developer hosts the dev level adds. */
  sandboxTiers: {
    max: SandboxTier;
    default: SandboxTier;
    allowUnsandboxed: boolean;
    devHosts: string[];
  };
  /** The platform's conversation compaction settings; absent from an older kernel. */
  compaction?: CompactionSettings;
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

/** PATCH 体：`sandboxEgress: null` 恢复跟随部署默认。 */
export type OrgSettingsPatch = Partial<
  Omit<
    OrgSettings,
    "sandboxEgress" | "sandboxTier" | "timeZone" | "theme" | "scheduledTasks" | "compaction"
  >
> & {
  /** The scheduled-task fields to change; the rest keep their value. */
  scheduledTasks?: Partial<ScheduledTasksSettings>;
  /** null clears the theme setting (follow the platform, allowed). */
  theme?: OrgThemeSetting | null;
  sandboxEgress?: SandboxEgressSetting | null;
  /** null clears it (follow the platform). */
  sandboxTier?: SandboxTierSetting | null;
  /** null clears the default (UTC). */
  timeZone?: string | null;
  /** Per slot: the entry replaces the org's, null removes it (follow the platform). */
  uiArrangement?: Record<string, UiArrangementEntry | null>;
  /** The fields to override; null clears the whole override (follow the platform again). */
  compaction?: CompactionSettingsPatch | null;
};

const path = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/settings`;

export const getOrgSettings = (orgId: string) => apiFetch<OrgSettingsResponse>(path(orgId));

export const updateOrgSettings = (orgId: string, patch: OrgSettingsPatch) =>
  apiFetch<OrgSettingsResponse>(path(orgId), {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

/** 主机清单文本（每行一个）→ 去空白、去空行、去重后的数组。 */
export function parseHostList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((h) => h.trim())
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
