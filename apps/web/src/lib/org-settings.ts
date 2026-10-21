import { apiFetch } from "./api";

/** 组织的沙箱出站（Ruling M19）：`allowHosts` 给出时替换部署的白名单，省略时沿用部署的。 */
export interface SandboxEgressSetting {
  mode: "none" | "allowlist";
  allowHosts?: string[];
}

/**
 * 组织设置（`packages/kernel/src/orgs/settings.controller.ts`）：成员可读，管理员可改。
 * - `toolSearch`：工具很多时改用目录 + `tool_search` 按需加载（默认 on）；
 * - `locale`：组织默认语言（默认 en），机器人在 IM 里说的固定话术按它选择；
 * - `sandboxToolPolicy`：沙箱工具的默认策略（默认 allow；ask 时除只读工具外都要审批）；
 * - `sandboxEgress`：沙箱出站，缺省跟随部署默认（`deployment.sandboxEgress`）。
 */
export interface OrgSettings {
  toolSearch: "on" | "off";
  locale: "zh" | "en";
  /** 旧内核没有这个字段：缺省按 allow。 */
  sandboxToolPolicy?: "allow" | "ask";
  sandboxEgress?: SandboxEgressSetting;
}

/** 部署默认值（旧内核不返回）。 */
export interface OrgSettingsDeployment {
  sandboxEgress: { mode: "none" | "allowlist" | "open"; allowHosts: string[] };
}

export interface OrgSettingsResponse {
  settings: OrgSettings;
  deployment?: OrgSettingsDeployment;
}

/** PATCH 体：`sandboxEgress: null` 恢复跟随部署默认。 */
export type OrgSettingsPatch = Partial<Omit<OrgSettings, "sandboxEgress">> & {
  sandboxEgress?: SandboxEgressSetting | null;
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
