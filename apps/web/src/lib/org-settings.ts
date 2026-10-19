import { apiFetch } from "./api";

/**
 * 组织设置（`packages/kernel/src/orgs/settings.controller.ts`）：成员可读，管理员可改。
 * - `toolSearch`：工具很多时改用目录 + `tool_search` 按需加载（默认 on）。
 */
export interface OrgSettings {
  toolSearch: "on" | "off";
}

const path = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/settings`;

export const getOrgSettings = (orgId: string) => apiFetch<{ settings: OrgSettings }>(path(orgId));

export const updateOrgSettings = (orgId: string, patch: Partial<OrgSettings>) =>
  apiFetch<{ settings: OrgSettings }>(path(orgId), {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

/** 能否修改组织设置（`org.update`：管理员起；只用于界面，最终由内核判定）。 */
export function canUpdateOrg(me: {
  currentOrgId: string | null;
  memberships: { orgId: string; role: string }[];
}): boolean {
  const role = me.memberships.find((m) => m.orgId === me.currentOrgId)?.role;
  return role === "admin" || role === "owner";
}
